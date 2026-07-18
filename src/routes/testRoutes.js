import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";

const router = Router();

// Anyone with a valid token can access this
router.get("/protected", authenticate, (req, res) => {
  res.status(200).json({
    success: true,
    data: { message: "You are authenticated", user: req.user },
  });
});

// Only product_admin or super_admin can access this
router.get(
  "/admin-only",
  authenticate,
  authorize("product_admin", "super_admin"),
  (req, res) => {
    res.status(200).json({
      success: true,
      data: { message: "You are an admin", user: req.user },
    });
  }
);

export default router;