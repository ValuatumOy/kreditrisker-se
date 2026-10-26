# Search Lambda image. Build context: data/build/search (scripts/search-db.ts writes both files there).
FROM public.ecr.aws/lambda/nodejs:22
COPY handler.mjs search.sqlite ${LAMBDA_TASK_ROOT}/
CMD ["handler.handler"]
