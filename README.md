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
- `PAYSTACK_SECRET_KEY`: Paystack secret key whose mode must match `NODE_ENV`
- `PAYSTACK_CALLBACK_URL`: absolute callback URL required by the environment schema

The following variables are optional:

- `NODE_ENV`: runtime mode, normally `development` or `production`
- `PORT`: HTTP port; defaults to `5000`
- `SENTRY_DSN`: Sentry project DSN for error monitoring

### Paystack key mode

The application validates the Paystack key during startup:

- Use a key beginning with `sk_live_` when `NODE_ENV=production`.
- Use a key beginning with `sk_test_` when `NODE_ENV=development` or `NODE_ENV=test`.

A mismatched key causes startup to fail intentionally. Configure both Paystack variables in the deployment environment; never put a real Paystack secret in `.env.example` or commit it to Git.

Never commit `.env` or real credentials. The repository ignores `.env`; `.env.example` contains documentation-only placeholders and is safe to commit.

## Run locally

```powershell
npm install
npm run dev
```
