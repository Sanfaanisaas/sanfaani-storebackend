import app from "./src/app.js";
import { env } from "./src/config/env.js";
import { connectDB } from "./src/config/db.js";
import * as Sentry from "@sentry/node";

if (env.sentryDsn) {
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.nodeEnv,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
    ],
    tracesSampleRate: 1.0,
    beforeSend(event) {
      if (event.request && event.request.data) {
        // Scrub sensitive body fields
        if (typeof event.request.data === "string") {
          try {
            const data = JSON.parse(event.request.data);
            if (data.password) data.password = "[SCRUBBED]";
            event.request.data = JSON.stringify(data);
          } catch (e) {}
        }
      }
      if (event.request && event.request.headers) {
        // Scrub sensitive headers
        if (event.request.headers["authorization"]) event.request.headers["authorization"] = "[SCRUBBED]";
        if (event.request.headers["x-paystack-signature"]) event.request.headers["x-paystack-signature"] = "[SCRUBBED]";
      }
      return event;
    },
  });
}

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  console.log("UNCAUGHT EXCEPTION! 💥 Shutting down...");
  console.log(err.name, err.message);
  process.exit(1);
});

// Connect to DB, then start server
connectDB().then(() => {
  const server = app.listen(env.port, () => {
    console.log(`🚀 Server running on http://localhost:${env.port} in ${env.nodeEnv} mode`);
  });

  // Handle unhandled rejections
  process.on("unhandledRejection", (err) => {
    console.log("UNHANDLED REJECTION! 💥 Shutting down...");
    console.log(err.name, err.message);
    server.close(() => {
      process.exit(1);
    });
  });
});