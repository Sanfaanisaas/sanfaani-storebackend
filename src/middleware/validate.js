export function validate(schema, source = "body") {
  return (req, res, next) => {
    const dataToValidate = source === "query" ? req.query : req.body;
    const result = schema.safeParse(dataToValidate);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join(".") || source,
          code: issue.code,
          message: issue.message,
        })),
      });
    }

    if (source === "query") {
      req.query = result.data;
    } else {
      req.body = result.data;
    }
    next();
  };
}
