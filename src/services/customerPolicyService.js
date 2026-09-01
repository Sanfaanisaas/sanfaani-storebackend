export const SERVICE_RESPONSIBILITY_POLICY = Object.freeze({
  version: "2026-07-device-data",
  source: "/policies/device-data",
  responsibilities: [
    "Back up personal data before service.",
    "Customer-owned software licences are required unless a quote explicitly includes them.",
    "Do not provide passwords, recovery keys, or payment credentials.",
    "Compatibility remains uncertain until the assessment is complete.",
  ],
  exclusions: [
    "Data-loss outcomes are not guaranteed.",
    "Third-party software limitations may affect the requested service.",
    "Accessories and services are excluded unless itemised in the quotation.",
  ],
});
