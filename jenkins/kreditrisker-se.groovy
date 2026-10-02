// Production build for the Swedish directory, same model as the Finnish and
// Danish jobs: list every company, build pages only for those that changed,
// copy the result on top of the S3 bucket behind CloudFront.
//
// Differences from the Danish job:
//  - a Fetch stage (scripts/fetch.ts) pulls the batch from the Swedish REST API
//    before `astro build`, so network errors never break the page build;
//  - the directory index (data/build/index.jsonl) is carried between runs in
//    STATE_URI, so hubs, rankings and sitemaps always cover every company;
//  - companies that left the list are deleted from the bucket;
//  - BUILD_UNBUILT builds the initial 400k pages in nightly chunks.
// Testing does not go through this job: see docs/BUILD-AND-DEPLOY.md.

pipeline {
    agent { label 'REPLACE_ME_AGENT_LABEL' }

    parameters {
        stashedFile 'includeparams.txt'
        string(name: 'SINCE', defaultValue: '24 hours ago', description: 'Include fids updated since this time (linux date syntax).')
        string(name: 'BUILD_UNBUILT', defaultValue: '0', description: 'Also build up to this many companies that have no page yet.')
        booleanParam(name: 'DEPLOY', defaultValue: true, description: 'Upload to S3 and save the index state')
        string(name: 'GIT_BRANCH', defaultValue: 'main', description: 'Git branch')
    }

    environment {
        AWS_REGION = 'eu-west-1'
        BUILD_BUCKET = 'REPLACE_ME_SE_BUCKET'
        CLOUDFRONT_DISTRIBUTION_ID = 'REPLACE_ME_SE_CLOUDFRONT_ID'
        STATE_URI = 'REPLACE_ME_PRIVATE_STATE_URI' // e.g. s3://valu-produ/kreditrisker-se/state/index.jsonl, never in the public bucket
        STATIC_PARAMS_PROPERTIES = 'REPLACE_ME_SE_PROPERTIES_PATH'
        SE_ACCOUNTS = 'XBRLSweden'

        BUILD_STATIC_PARAMS_FILE = 'staticparams_batch.txt'
        BUILD_STATIC_PARAMS_FILE_ALL = 'staticparams.txt'
        SE_INDEX_IN = 'prev-index.jsonl'
        PUBLIC_VALUATUM_API_BASE_URL = 'REPLACE_ME_SE_REST_BASE_URL'
        SECRET_VALUATUM_API_TOKEN = credentials('REPLACE_ME_SE_API_TOKEN_CRED_ID')
        SE_SITE_ORIGIN = 'https://www.kreditrisker.se'
        SE_INDEXING = '0' // launch gates 1-3 and 9 (docs/LAUNCH-GATES.md)
    }

    stages {
        stage('Preparation') {
            steps {
                checkout([$class: 'GitSCM', branches: [[name: "*/${params.GIT_BRANCH}"]],
                    userRemoteConfigs: [[credentialsId: 'REPLACE_ME_GIT_CRED_ID', url: 'https://github.com/ValuatumOy/kreditrisker-se.git']]])
                sh 'npm ci'
            }
        }

        stage('Get static params') {
            steps {
                sh 'rm -f includeparams.txt'
                script {
                    try { unstash 'includeparams.txt' } catch (e) { echo 'No includeparams.txt provided.' }
                }
                sh '''#!/bin/bash
                    set -e
                    rm -f "$BUILD_STATIC_PARAMS_FILE" "$BUILD_STATIC_PARAMS_FILE_ALL"
                    npm run build:scripts
                    ./build/bin/get_static_params_arm64 \
                        --output-dir . \
                        --properties "$STATIC_PARAMS_PROPERTIES" \
                        --accounts "$SE_ACCOUNTS" \
                        --include-updated-since $(($(date -d "$SINCE" +%s) * 1000))
                    touch "$BUILD_STATIC_PARAMS_FILE"
                    if [ -f includeparams.txt ]; then cat includeparams.txt >> "$BUILD_STATIC_PARAMS_FILE"; fi
                    echo "batch: $(wc -l < "$BUILD_STATIC_PARAMS_FILE") fids, directory: $(wc -l < "$BUILD_STATIC_PARAMS_FILE_ALL")"
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
    }

    post {
        always {
            archiveArtifacts artifacts: '*params*.txt, data/build/rejected.jsonl, data/build/removed.txt', allowEmptyArchive: true, fingerprint: true
        }
    }
}
