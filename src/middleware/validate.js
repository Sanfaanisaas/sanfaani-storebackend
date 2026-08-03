export function validate(schema, source = "body") {
  return (req, res, next) => {
    const dataToValidate = source === "query" ? req.query : req.body;
    const result = schema.safeParse(dataToValidate);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: result.error.flatten().fieldErrors,
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