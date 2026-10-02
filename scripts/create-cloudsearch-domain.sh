#!/bin/bash
# One-off recipe for the Swedish company-search domain (CloudFormation cannot
# create CloudSearch domains). Same shape as the Finnish/Danish domains, with
# the fields scripts/search-docs.ts writes. Usage:
#   ./scripts/create-cloudsearch-domain.sh sweden-companies-test
#   ./scripts/create-cloudsearch-domain.sh sweden-companies-prod
# Then put the domain's search endpoint (describe-domains .SearchService.Endpoint)
# into aws-infra context searchEndpointTest/Prod, and its document endpoint into
# the Jenkins job's CLOUDSEARCH_DOC_ENDPOINT.
set -euo pipefail
DOMAIN="${1:?domain name}"
export AWS_REGION="${AWS_REGION:-eu-west-1}"

aws cloudsearch create-domain --domain-name "$DOMAIN"
aws cloudsearch update-scaling-parameters --domain-name "$DOMAIN" \
    --scaling-parameters DesiredInstanceType=search.small,DesiredReplicationCount=1,DesiredPartitionCount=0

# Public search only (no document upload), as on the Finnish/Danish domains.
aws cloudsearch update-service-access-policies --domain-name "$DOMAIN" \
    --access-policies '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"*"},"Action":["cloudsearch:search"]}]}'

field() { aws cloudsearch define-index-field --domain-name "$DOMAIN" "$@" >/dev/null; }
field --name orgnr  --type literal --search-enabled true  --return-enabled true --facet-enabled false --sort-enabled false
field --name name   --type text    --return-enabled true  --sort-enabled true --highlight-enabled false --analysis-scheme _sv_default_
field --name former --type text    --return-enabled true  --sort-enabled false --highlight-enabled false --analysis-scheme _sv_default_
for f in path kommun sni status year fresh; do
    field --name "$f" --type literal --search-enabled false --return-enabled true --facet-enabled false --sort-enabled false
done
field --name sales  --type int     --search-enabled false --return-enabled false --facet-enabled false --sort-enabled true

aws cloudsearch index-documents --domain-name "$DOMAIN"
aws cloudsearch describe-domains --domain-names "$DOMAIN" --query 'DomainStatusList[0].[SearchService.Endpoint,DocService.Endpoint]'
