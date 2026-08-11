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
      schemas: {
        WarrantyTerms: {
          type: "object",
          required: ["version", "terms"],
          additionalProperties: false,
          properties: {
            version: { type: "string", example: "2024-01-01" },
            terms: {
              type: "string",
              example: "Ninety-day limited repair warranty",
            },
          },
        },
        Inspection: {
          type: "object",
          required: ["summary"],
          additionalProperties: false,
          properties: {
            summary: { type: "string", example: "All documented checks passed" },
            inspectedAt: { type: "string", format: "date-time" },
            inspector: { type: "string" },
          },
        },
        ConditionEvidence: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: {
            url: { type: "string", format: "uri" },
            alt: { type: "string" },
          },
        },
        CatalogueVariantInput: {
          type: "object",
          required: ["product", "sku", "attributes", "price", "condition"],
          properties: {
            product: { type: "string", description: "Owning Product ObjectId" },
            sku: { type: "string" },
            attributes: { type: "object", additionalProperties: true },
            price: { type: "number", minimum: 0 },
            condition: {
              type: "string",
              enum: [
                "new",
                "refurbished_grade_a",
                "refurbished_grade_b",
                "used_grade_a",
                "used_grade_b",
              ],
            },
            inspection: { $ref: "#/components/schemas/Inspection" },
            limitations: { type: "string", example: "None" },
            conditionEvidence: {
              type: "array",
              items: { $ref: "#/components/schemas/ConditionEvidence" },
            },
            warranty: { $ref: "#/components/schemas/WarrantyTerms" },
            inStock: { type: "number", minimum: 0 },
            sourcing: {
              type: "object",
              description: "Internal sourcing inventory mode; mutually exclusive with inStock.",
              required: ["supplier", "leadTimeDays", "costPrice"],
              properties: {
                supplier: { type: "string" },
                leadTimeDays: { type: "number", minimum: 0 },
                costPrice: { type: "number", minimum: 0 },
              },
            },
          },
          oneOf: [
            { required: ["inStock"], not: { required: ["sourcing"] } },
            { required: ["sourcing"], not: { required: ["inStock"] } },
          ],
        },
        PublicVariant: {
          type: "object",
          description: "Customer-safe variant projection; procurement and exact stock fields are omitted.",
          required: ["id", "sku", "attributes", "price", "condition", "availability"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            sku: { type: "string", example: "PHONE-BLK-128" },
            attributes: { type: "object", additionalProperties: true },
            price: { type: "number", minimum: 0 },
            condition: {
              type: "string",
              enum: [
                "new",
                "refurbished_grade_a",
                "refurbished_grade_b",
                "used_grade_a",
                "used_grade_b",
              ],
            },
            inspection: { $ref: "#/components/schemas/Inspection" },
            limitations: { type: "string", example: "None" },
            conditionEvidence: {
              type: "array",
              items: { $ref: "#/components/schemas/ConditionEvidence" },
            },
            warranty: { $ref: "#/components/schemas/WarrantyTerms" },
            availability: {
              type: "string",
              enum: ["in_stock", "low_stock", "out_of_stock", "sourcing"],
            },
          },
        },
        PublicProduct: {
          type: "object",
          description: "Allowlisted public catalogue projection; lifecycle and migration fields are omitted.",
          required: ["id", "name", "slug", "description", "category", "brand", "images", "variants"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            slug: { type: "string", example: "iphone-15-pro" },
            description: { type: "string" },
            category: { type: "string" },
            brand: { type: "string" },
            images: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            isFeatured: { type: "boolean" },
            seo: { type: "object" },
            variants: {
              type: "array",
              items: { $ref: "#/components/schemas/PublicVariant" },
            },
          },
        },
        PublicationRequirement: {
          type: "object",
          required: ["code", "path", "message"],
          properties: {
            code: { type: "string", example: "product.variants.required" },
            path: { type: "string", example: "variants" },
            message: { type: "string", example: "At least one owned variant is required" },
            variantId: { type: "string" },
            sku: { type: "string" },
          },
        },
        PublicationError: {
          type: "object",
          required: ["success", "message", "errors"],
          properties: {
            success: { type: "boolean", const: false },
            message: { type: "string", const: "Publication requirements not met" },
            errors: {
              type: "array",
              items: { $ref: "#/components/schemas/PublicationRequirement" },
            },
          },
        },
      },
    },
  },
  apis: ["./src/routes/*.js"], // where swagger-jsdoc looks for the comments
};

export const swaggerSpec = swaggerJSDoc(options);
