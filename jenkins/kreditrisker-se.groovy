// Production build for the Swedish directory, same model as the Finnish and
// Danish jobs: list every company, build pages only for those that changed,
// copy the result on top of the S3 bucket behind CloudFront.
//
// One field to fill: COMPANIES. Every other parameter defaults to a production
// run, so "Build with Parameters" -> type the org numbers -> Build is enough:
//   build or rebuild companies  COMPANIES=556448-0282, 5565675906
//   nightly (scheduled)         COMPANIES empty: companies updated since SINCE
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

    parameters {
        text(name: 'COMPANIES', defaultValue: '', description: '''Organisationsnummer (with or without the hyphen) or model ids (fid), separated by commas, spaces or new lines. Example: 556448-0282, 5565675906. Only these pages are built and published. The run stops if one is not in the directory.
Empty: the nightly run (companies updated since SINCE). "all": every company.
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
        SE_INDEXING = '0' // launch gates 1-3 and 9 (docs/LAUNCH-GATES.md)
        PUBLIC_SE_SEARCH_ENDPOINT = '/api/search' // CloudFront -> search Lambda (aws-infra)
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
                    rm -f "$BUILD_STATIC_PARAMS_FILE" "$BUILD_STATIC_PARAMS_FILE_ALL"
                    since_args=()
                    if [ -z "$(echo "$COMPANIES" | tr -d '[:space:]')" ]; then
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
            }
        }

        stage('Fetch') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    aws s3 cp "$STATE_URI" "$SE_INDEX_IN" || echo "No previous index state; starting empty."
                    SE_API_REFRESH=1 npm run fetch
                '''
            }
        }

        stage('Build') {
            steps {
                sh 'SE_DATA_SOURCE=build npm run build'
            }
        }

        stage('Deploy') {
            when { expression { params.DEPLOY } }
            steps {
                sh '''#!/bin/bash
                    set -e
                    aws s3 cp --recursive dist "s3://$BUILD_BUCKET" --only-show-errors
                    while read -r prefix; do
                        [ -n "$prefix" ] && aws s3 rm --recursive "s3://$BUILD_BUCKET/$prefix" --only-show-errors
                    done < data/build/removed.txt
                    aws s3 cp data/build/index.jsonl "$STATE_URI" --only-show-errors
                    aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/*"
                '''
            }
        }

        stage('Update search') {
            // The image goes to the search repository as :latest; the Lambda is pointed at its digest, so rolling
            // back is update-function-code with an older digest (the repository keeps the last 5 images).
            when { expression { params.DEPLOY && params.UPDATE_SEARCH && env.SEARCH_FUNCTION && env.SEARCH_REPOSITORY } }
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
            archiveArtifacts artifacts: '*params*.txt, data/build/rejected.jsonl, data/build/removed.txt', allowEmptyArchive: true, fingerprint: true
        }
    }
}
