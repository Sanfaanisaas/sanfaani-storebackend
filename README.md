# Sanfaani Store API

## Environment setup

Copy `.env.example` to `.env` and replace its placeholder values:

```powershell
Copy-Item .env.example .env
```

The application requires these variables at startup:

- `MONGO_URI`: MongoDB connection string
- `JWT_SECRET`: secret used to sign access tokens
- `JWT_REFRESH_SECRET`: separate secret used to sign refresh tokens
- `PAYSTACK_SECRET_KEY`: Paystack secret key whose prefix must match `PAYSTACK_MODE`
- `PAYSTACK_CALLBACK_URL`: absolute callback URL required by the environment schema

The following variables are optional:

- `NODE_ENV`: runtime mode, normally `development` or `production`
- `PAYSTACK_MODE`: Paystack transaction mode, `test` by default or `live`
- `PORT`: HTTP port; defaults to `5000`
- `SENTRY_DSN`: Sentry project DSN for error monitoring

### Paystack key mode

`NODE_ENV` controls Node.js runtime behavior. `PAYSTACK_MODE` independently
controls Paystack transaction mode. The application supports these hosted
configurations:

| `NODE_ENV` | `PAYSTACK_MODE` | Required key prefix | Purpose |
| --- | --- | --- | --- |
| `production` | `test` | `sk_test_` | Hosted staging/testing |
| `production` | `live` | `sk_live_` | Real production transactions |

A mismatched key causes startup to fail intentionally. Keep `PAYSTACK_MODE=test`
on Render until live transactions are deliberately enabled. Configure all
Paystack variables in the deployment environment; never put a real Paystack
secret in `.env.example` or commit it to Git.

Never commit `.env` or real credentials. The repository ignores `.env`; `.env.example` contains documentation-only placeholders and is safe to commit.

## Run locally

```powershell
npm install
npm run dev
```
