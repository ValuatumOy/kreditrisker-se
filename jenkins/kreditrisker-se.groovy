// Production build for the Swedish directory, same model as the Finnish and
// Danish jobs: list every company, build pages only for those that changed,
// copy the result on top of the S3 bucket behind CloudFront.
//
// One field to fill: COMPANIES. Every other parameter defaults to a production
// run, so "Build with Parameters" -> type the org numbers -> Build is enough:
//   build or rebuild companies  COMPANIES=556448-0282, 5565675906
//   nightly (scheduled)         COMPANIES empty: companies updated since SINCE
//   everything                  COMPANIES=all (SEARCH_FULL on the first time)
//
// Differences from the Danish job:
//  - a Fetch stage (scripts/fetch.ts) pulls the batch from the Swedish REST API
//    before `astro build`, so network errors never break the page build;
//  - the directory index (data/build/index.jsonl) is carried between runs in
//    STATE_URI, so hubs, rankings and sitemaps always cover every company;
//  - companies that left the list are deleted from the bucket;
//  - BUILD_UNBUILT builds the initial pages in nightly chunks.
// The helper binaries are committed in build/bin/ (agents have no Go): after
// changing build/get_static_params, run `npm run build:scripts` and commit them.
// Testing does not go through this job: see docs/BUILD-AND-DEPLOY.md.

pipeline {
    agent { label 'REPLACE_ME_AGENT_LABEL' } // arm64, Node >= 22.12, AWS CLI

    parameters {
        text(name: 'COMPANIES', defaultValue: '', description: '''Organisationsnummer (with or without the hyphen) or model ids (fid), separated by commas, spaces or new lines. Example: 556448-0282, 5565675906. Only these pages are built and published. The run stops if one is not in the directory.
Empty: the nightly run (companies updated since SINCE). "all": every company.
The fields below are already set for a production run; leave them as they are.''')
        string(name: 'SINCE', defaultValue: '24 hours ago', description: 'Empty COMPANIES only: include companies updated since this time (linux date syntax).')
        string(name: 'BUILD_UNBUILT', defaultValue: '0', description: 'Also build up to this many companies that have no page yet (first load in nightly chunks).')
        booleanParam(name: 'DEPLOY', defaultValue: true, description: 'Upload to S3, save the index state and update search. Off: list, fetch and build only (a test run).')
        booleanParam(name: 'SEARCH_FULL', defaultValue: false, description: 'Re-upload every company to CloudSearch (first load)')
        string(name: 'GIT_BRANCH', defaultValue: 'main', description: 'Git branch')
    }

    environment {
        AWS_REGION = 'eu-west-1'
        BUILD_BUCKET = 'REPLACE_ME_SE_BUCKET'
        CLOUDFRONT_DISTRIBUTION_ID = 'REPLACE_ME_SE_CLOUDFRONT_ID'
        STATE_URI = 'REPLACE_ME_PRIVATE_STATE_URI' // SiteStack output StateUri (private bucket)
        CLOUDSEARCH_DOC_ENDPOINT = 'REPLACE_ME_SE_CLOUDSEARCH_DOC_ENDPOINT' // scripts/create-cloudsearch-domain.sh
        STATIC_PARAMS_PROPERTIES = 's3://valu-produ/sweden/config/local_server.properties'
        SE_ACCOUNTS = 'Bolagsverket data import' // comma-separated USERACCOUNT nicknames

        BUILD_STATIC_PARAMS_FILE = 'staticparams_batch.txt'
        BUILD_STATIC_PARAMS_FILE_ALL = 'staticparams.txt'
        SE_INDEX_IN = 'prev-index.jsonl'
        PUBLIC_VALUATUM_API_BASE_URL = 'https://sweden.valuatum.com'
        SECRET_VALUATUM_API_TOKEN = credentials('REPLACE_ME_SE_API_TOKEN_CRED_ID') // Secret text: token of user swecompanydirectory
        SE_SITE_ORIGIN = 'https://www.kreditrisker.se'
        SE_INDEXING = '0' // launch gates 1-3 and 9 (docs/LAUNCH-GATES.md)
        PUBLIC_SE_SEARCH_ENDPOINT = '/api/search' // CloudFront -> CloudSearch (aws-infra)
    }

    stages {
        stage('Preparation') {
            steps {
                // Public repo: anonymous HTTPS clone, no Jenkins credential or deploy key needed.
                checkout([$class: 'GitSCM', branches: [[name: "*/${params.GIT_BRANCH}"]],
                    userRemoteConfigs: [[url: 'https://github.com/ValuatumOy/kreditrisker-se.git']]])
                sh 'npm ci'
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
                    ./build/bin/get_static_params_arm64 \
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
                    SE_BUILD_UNBUILT="$BUILD_UNBUILT" npm run fetch
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
            // Skipped until the Swedish CloudSearch domain exists (scripts/create-cloudsearch-domain.sh).
            when { expression { params.DEPLOY && !env.CLOUDSEARCH_DOC_ENDPOINT.startsWith('REPLACE_ME') } }
            steps {
                sh '''#!/bin/bash
                    set -e
                    node scripts/search-docs.ts $( [ "$SEARCH_FULL" = "true" ] && echo --full )
                    for f in data/build/search/batch-*.json; do
                        [ -f "$f" ] || continue
                        aws cloudsearchdomain upload-documents --endpoint-url "https://$CLOUDSEARCH_DOC_ENDPOINT" \
                            --content-type application/json --documents "$f" > /dev/null
                        echo "uploaded $f"
                    done
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
