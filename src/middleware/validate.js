export function validate(schema, source = "body") {
  return (req, res, next) => {
    const dataToValidate = source === "query"
      ? req.query
      : source === "params" ? req.params : req.body;
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
      if (req.query && typeof req.query === "object") {
        for (const key of Object.keys(req.query)) {
          delete req.query[key];
        }
        Object.assign(req.query, result.data);
      }
    } else if (source === "params") {
      if (req.params && typeof req.params === "object") {
        for (const key of Object.keys(req.params)) {
          delete req.params[key];
        }
        Object.assign(req.params, result.data);
      }
    } else {
      req.body = result.data;
    }
    next();
  };
}
