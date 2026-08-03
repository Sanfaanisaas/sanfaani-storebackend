import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { 
  createSupportTicket, 
  replyToTicket, 
  updateTicketStatus, 
  getMyTickets 
} from "../controllers/supportTicketController.js";
import { USER_ROLES } from "../utils/constants.js";

const router = Router();

router.get("/mine", authenticate, getMyTickets);
router.post("/", authenticate, createSupportTicket);
router.post("/:id/reply", authenticate, replyToTicket);

router.patch(
  "/:id/status",
  authenticate,
  authorize(USER_ROLES.SUPPORT_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  updateTicketStatus
);

export default router;
