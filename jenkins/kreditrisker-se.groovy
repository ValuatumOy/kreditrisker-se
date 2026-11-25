// Production build for the Swedish directory, same model as the Finnish and
// Danish jobs: list every company, build pages only for those that changed,
// copy the result on top of the S3 bucket behind CloudFront.
//
// One field to fill: COMPANIES. Every other parameter defaults to a production
// run, so "Build with Parameters" -> type the org numbers -> Build is enough:
//   build or rebuild companies  COMPANIES=556448-0282, 5565675906
//   build new profiles          COMPANIES=new:1000
//   scheduled weekly            bounded automatic legacy/changed + unpublished selection,
//                               Wednesday 1-2 am Finnish time, after Monday's weekly import
//   manual changed build       COMPANIES empty: companies updated since SINCE
//   everything                  COMPANIES=all
//
// Differences from the Danish job:
//  - a Fetch stage (scripts/fetch.ts) pulls the batch from the Swedish REST API
//    before `astro build`, so network errors never break the page build;
//  - the directory index (data/build/index.jsonl) is carried between runs in
//    STATE_URI, so hubs, rankings and sitemaps always cover every company;
//  - companies that left the list are deleted from the bucket;
//  - search is a Lambda with an SQLite database rebuilt from the whole index every run
//    (no CloudSearch): the job uploads the package and points the Lambda at it;
// The helper binaries are committed in build/bin/ (agents have no Go): after
// changing build/get_static_params, run `npm run build:scripts` and commit them.
// Testing does not go through this job: see docs/BUILD-AND-DEPLOY.md.
//
// Jenkins job setup (nothing in this file needs editing):
//  - Pipeline script from SCM: git@bitbucket.org:valuatum/kreditrisker-se.git, branch */main,
//    script path jenkins/kreditrisker-se.groovy, the same Bitbucket credential as the other jobs.
//  - Secret text credential 'kreditrisker-se-api-token': API token of sweden.valuatum.com (KeePass).
//  - Agent sweden-build: its role (sweden-process-role) reaches sweden-db and reads the Sweden
//    config; KreditriskerSiteStackProd grants it the buckets, invalidation, the search Lambda's code
//    and the stack outputs.
// Bucket, distribution, state, site origin and search Lambda are read from the stack outputs at run time.

pipeline {
    agent { label 'sweden-build' }

    options { disableConcurrentBuilds() } // the index state in STATE_URI is read and written by every run
    // Weekly: Bolagsverket's weekly import starts on Monday at 5 am and takes about 8 hours.
    triggers { cron('TZ=Europe/Helsinki\nH 1 * * 3') }

    parameters {
        text(name: 'COMPANIES', defaultValue: '', description: '''Organisationsnummer (with or without the hyphen) or model ids (fid), separated by commas, spaces or new lines. Example: 556448-0282, 5565675906. Only these pages are built and published. The run stops if one is not in the directory.
Empty: companies updated since SINCE. "all": every company, up to the 10,000-row safety limit. A larger build requires a separately verified process.
"new:1000": up to 1,000 companies with models available and no profile in the published index.
"auto": the same bounded existing/new selection as the weekly schedule.
The fields below are already set for a production run; leave them as they are.''')
        string(name: 'SINCE', defaultValue: '24 hours ago', description: 'Empty COMPANIES only: include companies updated since this time (linux date syntax).')
        booleanParam(name: 'DEPLOY', defaultValue: true, description: 'Upload to S3, save the index state and update search. Off: list, fetch and build only (a test run).')
        booleanParam(name: 'UPDATE_SEARCH', defaultValue: true, description: 'Rebuild the site search from the whole directory and deploy it to the search Lambda.')
    }

    environment {
        AWS_REGION = 'eu-west-1'
        AWS_DEFAULT_REGION = 'eu-west-1'
        SITE_STACK = 'KreditriskerSiteStackProd'
        STATIC_PARAMS_PROPERTIES = 's3://valu-produ/sweden/config/local_server.properties'
        SE_ACCOUNTS = 'Bolagsverket data import' // comma-separated USERACCOUNT nicknames
        NODE_VERSION = '22.20.0' // used only when the agent has no Node >= 22.12

        BUILD_STATIC_PARAMS_FILE = 'staticparams_batch.txt'
        BUILD_STATIC_PARAMS_FILE_ALL = 'staticparams.txt'
        SE_INDEX_IN = 'prev-index.jsonl'
        PUBLIC_VALUATUM_API_BASE_URL = 'https://sweden.valuatum.com'
        SECRET_VALUATUM_API_TOKEN = credentials('kreditrisker-se-api-token')
        SE_INDEXING = '1'
        // Legacy rows are excluded; normal batches earn eligibility from verified HTML.
        SE_COMPANY_SITEMAP = 'verified'
        PUBLIC_SE_SEARCH_ENDPOINT = '/api/search' // CloudFront -> search Lambda (aws-infra)
        PUBLIC_GA_TRACKING_ID = 'G-10WF1WRH4W'
        PUBLIC_GA_FRAME_ORIGIN = 'https://kreditrisker.se'
        SE_REPORT_BASIC = 'live'
        SE_REPORT_AI = 'unavailable'
        SE_CHECKOUT = '1'
        SE_TERMS_VERSION = '2026-10-30'
        PUBLIC_SE_REPORT_ADAPTER = 'http'
        PUBLIC_SE_REPORT_API = '/api/'
    }

    stages {
        stage('Preparation') {
            steps {
                checkout scm
                script {
                    env.SE_TIMER_BATCH = currentBuild.getBuildCauses('hudson.triggers.TimerTrigger$TimerTriggerCause').size() > 0 ? '1' : '0'
                    env.SE_AUTO_BATCH = (env.SE_TIMER_BATCH == '1' || params.COMPANIES.trim().equalsIgnoreCase('auto')) ? '1' : '0'
                    env.SE_SKIP_BATCH = '0'
                    def out = { key -> sh(returnStdout: true, script: "aws cloudformation describe-stacks --stack-name \"\$SITE_STACK\" --query \"Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue\" --output text").trim() }
                    env.BUILD_BUCKET = out('SiteBucketName')
                    env.CLOUDFRONT_DISTRIBUTION_ID = out('DistributionId')
                    env.STATE_URI = out('StateUri')
                    env.SE_SITE_ORIGIN = out('SiteOrigin')
                    env.SEARCH_FUNCTION = out('SearchFunctionName')
                    env.SEARCH_REPOSITORY = out('SearchRepositoryUri')
                    echo "bucket ${env.BUILD_BUCKET}, distribution ${env.CLOUDFRONT_DISTRIBUTION_ID}, site ${env.SE_SITE_ORIGIN}"
                }
                sh '''#!/bin/bash
                    set -e
                    if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a==22&&b>=12)?0:1)' 2>/dev/null; then
                        arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
                        echo "No Node >= 22.12 on the agent; using node-v$NODE_VERSION-linux-$arch in the workspace"
                        mkdir -p .node
                        curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.xz" | tar -xJ -C .node --strip-components=1
                    fi
                '''
                script { if (fileExists('.node/bin/node')) { env.PATH = "${env.WORKSPACE}/.node/bin:${env.PATH}" } }
                sh 'node --version && npm ci'
            }
        }

        stage('Get static params') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    # Keep batch selection and fetch tied to the same production index.
                    rm -f "$SE_INDEX_IN"
                    aws s3 cp "$STATE_URI" "$SE_INDEX_IN"
                    if [ ! -s "$SE_INDEX_IN" ]; then
                        echo "Existing index state is empty; refusing to build." >&2
                        exit 1
                    fi
                    rm -f "$BUILD_STATIC_PARAMS_FILE" "$BUILD_STATIC_PARAMS_FILE_ALL"
                    since_args=()
                    if [ "$SE_AUTO_BATCH" != '1' ] && [ -z "$(echo "$COMPANIES" | tr -d '[:space:]')" ]; then
                        since_args=(--include-updated-since $(($(date -d "$SINCE" +%s) * 1000)))
                    fi
                    arch=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
                    ./build/bin/get_static_params_$arch \
                        --output-dir . \
                        --properties "$STATIC_PARAMS_PROPERTIES" \
                        --accounts "$SE_ACCOUNTS" \
                        "${since_args[@]}"
                    node scripts/select-batch.ts
                    echo "batch: $(wc -l < "$BUILD_STATIC_PARAMS_FILE") rows, directory: $(wc -l < "$BUILD_STATIC_PARAMS_FILE_ALL")"
                '''
                script {
                    if (env.SE_AUTO_BATCH == '1' && !readFile(env.BUILD_STATIC_PARAMS_FILE).trim()) {
                        env.SE_SKIP_BATCH = '1'
                        echo 'No automatic company work; skipping fetch, build, deploy and search.'
                    }
                }
            }
        }

        stage('Fetch') {
            when { expression { env.SE_SKIP_BATCH != '1' } }
            steps {
                // SE_API_REFRESH=1 never reads data/api-cache, but fetch writes one file per company there and the
                // workspace survives between runs (the agent is stopped, not terminated): ~7 GB for the whole
                // directory on a 20 GB disk. Clear it before and after so it holds at most one batch.
                sh '''#!/bin/bash
                    set -e
                    rm -rf data/api-cache
                    SE_API_REFRESH=1 npm run fetch
                    rm -rf data/api-cache
                '''
                script {
                    def rejected = readFile('data/build/rejected.jsonl').readLines().count { it.trim() }
                    if (rejected) unstable("${rejected} companies were not built; review data/build/rejected.jsonl in the build artifacts")
                }
            }
        }

        stage('Build') {
            when { expression { env.SE_SKIP_BATCH != '1' } }
            steps {
                // ~64 KB of page data per company: a 16k batch is ~1 GB of pages.jsonl, too much for Node's default heap.
                sh '''#!/bin/bash
                    set -e
                    SE_DATA_SOURCE=build NODE_OPTIONS=--max-old-space-size=8192 npm run build
                    for prefix in branscher kommuner konkurser; do
                        [ -s "dist/$prefix/index.html" ] || { echo "Missing complete $prefix output" >&2; exit 1; }
                    done
                    NODE_OPTIONS=--max-old-space-size=8192 node scripts/company-sitemaps.ts
                '''
            }
        }

        stage('Deploy') {
            when { expression { params.DEPLOY && env.SE_SKIP_BATCH != '1' } }
            steps {
                sh '''#!/bin/bash
                    set -e
                    if { [ "$SE_AUTO_BATCH" = '1' ] || { [ -n "$(echo "$COMPANIES" | tr -d '[:space:]')" ] && [ "$COMPANIES" != "all" ]; }; } && [ -s data/build/removed.txt ]; then
                        echo "A named-company build would remove other company pages; review data/build/removed.txt first." >&2
                        exit 1
                    fi
                    publish_company_sitemaps() {
                        # Remove obsolete shards too: a crawler may still know their URLs.
                        aws s3 sync "$1/" "s3://$BUILD_BUCKET/" --delete --exclude '*' --include 'sitemap-companies-*.xml' --only-show-errors
                        aws s3 cp "$1/sitemap-index.xml" "s3://$BUILD_BUCKET/sitemap-index.xml" --only-show-errors
                    }
                    invalidate_and_wait() {
                        local id
                        id=$(aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "$1" --query 'Invalidation.Id' --output text)
                        aws cloudfront wait invalidation-completed --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --id "$id"
                    }
                    # Withdraw affected URLs before replacing HTML or deleting companies.
                    publish_company_sitemaps data/build/sitemap-withdrawal
                    invalidate_and_wait '/sitemap-*'
                    # A failed deployment must leave a safe state for the next incremental run.
                    aws s3 cp data/build/index-checkpoint.jsonl "$STATE_URI" --only-show-errors
                    aws s3 cp --recursive dist "s3://$BUILD_BUCKET" --exclude 'sitemap-*.xml' --only-show-errors
                    # These directories are rebuilt in full on every run. Remove obsolete
                    # list pages, but never sync-delete incremental company pages or assets.
                    for prefix in branscher kommuner konkurser; do
                        aws s3 sync "dist/$prefix/" "s3://$BUILD_BUCKET/$prefix/" --delete --only-show-errors
                    done
                    while read -r prefix; do
                        [ -n "$prefix" ] && aws s3 rm --recursive "s3://$BUILD_BUCKET/$prefix" --only-show-errors
                    done < data/build/removed.txt
                    # Clear old cached noindex HTML before advertising refreshed targets.
                    invalidate_and_wait '/*'
                    aws s3 cp dist/sitemap-pages.xml "s3://$BUILD_BUCKET/sitemap-pages.xml" --only-show-errors
                    aws s3 cp dist/sitemap-hubs.xml "s3://$BUILD_BUCKET/sitemap-hubs.xml" --only-show-errors
                    publish_company_sitemaps dist
                    aws s3 cp data/build/index.jsonl "$STATE_URI" --only-show-errors
                    invalidate_and_wait '/sitemap-*'
                '''
            }
        }

        stage('Update search') {
            // The image goes to the search repository as :latest; the Lambda is pointed at its digest, so rolling
            // back is update-function-code with an older digest (the repository keeps the last 5 images).
            when { expression { params.DEPLOY && params.UPDATE_SEARCH && env.SE_SKIP_BATCH != '1' && env.SEARCH_FUNCTION && env.SEARCH_REPOSITORY } }
            steps {
                sh '''#!/bin/bash
                    set -e
                    node scripts/search-db.ts
                    aws ecr get-login-password | docker login --username AWS --password-stdin "${SEARCH_REPOSITORY%%/*}"
                    # plain single-platform image: Lambda does not take buildx's attestation manifests
                    BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker build --platform linux/amd64 -t "$SEARCH_REPOSITORY:latest" -f search/Dockerfile data/build/search
                    docker push -q "$SEARCH_REPOSITORY:latest"
                    image=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$SEARCH_REPOSITORY:latest" | grep "^$SEARCH_REPOSITORY@")
                    docker image rm "$SEARCH_REPOSITORY:latest" > /dev/null
                    # Each image carries the whole search database; without pruning, its build cache and dangling
                    # layers accumulate on the agent's disk run after run.
                    docker builder prune -af > /dev/null || true
                    docker image prune -f > /dev/null || true
                    aws lambda update-function-code --function-name "$SEARCH_FUNCTION" --image-uri "$image" > /dev/null
                    aws lambda wait function-updated-v2 --function-name "$SEARCH_FUNCTION"
                    # The first call reads the new database into memory, so no visitor waits for it. On a new image
                    # Lambda's image cache is still cold and this takes ~10 s (180 MB); later instances read in ~1 s.
                    aws lambda invoke --cli-read-timeout 90 --function-name "$SEARCH_FUNCTION" --cli-binary-format raw-in-base64-out \\
                        --payload '{"ping":true}' ping.json > /dev/null
                    echo "search: image $image, ping $(cat ping.json)"
                    aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/api/search*" > /dev/null
                '''
            }
        }
    }

    post {
        always {
            script {
                def artifacts = env.SE_TIMER_BATCH == '1'
                    ? (env.SE_SKIP_BATCH == '1' ? env.BUILD_STATIC_PARAMS_FILE : "${env.BUILD_STATIC_PARAMS_FILE}, data/build/rejected.jsonl, data/build/warnings.jsonl, data/build/removed.txt")
                    : '*params*.txt, data/build/rejected.jsonl, data/build/warnings.jsonl, data/build/removed.txt, data/build/index-checkpoint.jsonl, data/build/sitemap-withdrawal/*.xml'
                archiveArtifacts artifacts: artifacts, allowEmptyArchive: true, fingerprint: true
            }
        }
    }
}
