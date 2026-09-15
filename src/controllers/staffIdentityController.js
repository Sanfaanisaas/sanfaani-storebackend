import { catchAsync } from "../utils/catchAsync.js";
import * as staff from "../services/staffIdentityService.js";

export const inviteStaff = catchAsync(async (req, res) => {
  const result = await staff.inviteStaff({ actor: req.user.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") });
  res.status(result.created ? 201 : 200).json({ success: true, data: { staff: result.staff, invitation: result.invitation } });
});
export const rotateStaffInvitation = catchAsync(async (req, res) => {
  const result = await staff.rotateInvitation({ actor: req.user.id, staffId: req.params.id, idempotencyKey: req.get("Idempotency-Key") });
  res.status(result.created ? 201 : 200).json({ success: true, data: { staff: result.staff, invitation: result.invitation } });
});
export const acceptStaffInvitation = catchAsync(async (req, res) => res.json({ success: true, data: { staff: await staff.acceptInvitation({ token: req.get("X-Staff-Invitation-Token"), password: req.body.password }) } }));
export const listStaff = catchAsync(async (req, res) => res.json({ success: true, data: await staff.listStaff({ actor: req.user.id, query: req.query }) }));
export const listStaffRoles = catchAsync(async (req, res) => res.json({ success: true, data: await staff.roleRegister(req.user.id) }));
export const changeStaffRole = catchAsync(async (req, res) => res.json({ success: true, data: await staff.changeRole({ actor: req.user.id, staffId: req.params.id, expectedVersion: req.body.expectedVersion, role: req.body.role, reason: req.body.reason }) }));
export const suspendStaff = catchAsync(async (req, res) => res.json({ success: true, data: await staff.suspendStaff({ actor: req.user.id, staffId: req.params.id, expectedVersion: req.body.expectedVersion, reason: req.body.reason }) }));
export const reactivateStaff = catchAsync(async (req, res) => res.json({ success: true, data: await staff.reactivateStaff({ actor: req.user.id, staffId: req.params.id, expectedVersion: req.body.expectedVersion, reason: req.body.reason }) }));
