import swaggerJSDoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.1.0",
    info: {
      title: "Sanfaani Store & Repair API",
      version: "1.0.0",
      description: "API documentation for the Sanfaani Store & Repair platform",
    },
    servers: [
      { url: "http://localhost:5000/api", description: "Local development" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
  apis: ["./src/routes/*.js"], // where swagger-jsdoc looks for the comments
};

export const swaggerSpec = swaggerJSDoc(options);