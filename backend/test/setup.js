// Products are sold only with a Stripe product id (see src/lib/products.js);
// tests use fixed fake ids.
process.env.STRIPE_PRODUCT_SE_AI ??= 'prod_test_se_ai'
process.env.STRIPE_PRODUCT_SE_BASIC ??= 'prod_test_se_basic'
process.env.STRIPE_PRODUCT_SE_BASIC_BUNDLE ??= 'prod_test_se_basic_bundle'
process.env.STRIPE_PRODUCT_SE_AI_BUNDLE ??= 'prod_test_se_ai_bundle'
