import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import SupportTicket from "../models/SupportTicket.js";
import { SUPPORT_TICKET_STATUS, USER_ROLES } from "../utils/constants.js";

export const createSupportTicket = catchAsync(async (req, res) => {
  const { subject, relatedOrder, relatedRepair, message } = req.body;

  const ticket = await SupportTicket.create({
    customer: req.user.id,
    subject,
    relatedOrder,
    relatedRepair,
    messages: [{
      author: req.user.id,
      body: message
    }]
  });

  res.status(201).json({
    success: true,
    data: ticket
  });
});

export const replyToTicket = catchAsync(async (req, res, next) => {
  const { body } = req.body;
  const ticket = await SupportTicket.findById(req.params.id);

  if (!ticket) {
    return next(new AppError("Ticket not found", 404));
  }

  // Authorization: customer who owns it or staff
  const isOwner = ticket.customer.toString() === req.user.id;
  const isStaff = [
    USER_ROLES.SUPPORT_OFFICER,
    USER_ROLES.OPS_MANAGER,
    USER_ROLES.SUPER_ADMIN
  ].includes(req.user.role);

  if (!isOwner && !isStaff) {
    return next(new AppError("You are not authorized to reply to this ticket", 403));
  }

  ticket.messages.push({
    author: req.user.id,
    body
  });

  await ticket.save();

  res.status(201).json({
    success: true,
    data: ticket
  });
});

export const updateTicketStatus = catchAsync(async (req, res, next) => {
  const { status } = req.body;
  const ticket = await SupportTicket.findById(req.params.id);

  if (!ticket) {
    return next(new AppError("Ticket not found", 404));
  }

  ticket.status = status;
  await ticket.save();

  res.status(200).json({
    success: true,
    data: ticket
  });
});

export const getMyTickets = catchAsync(async (req, res) => {
  const tickets = await SupportTicket.find({ customer: req.user.id })
    .sort({ updatedAt: -1 });

  res.status(200).json({
    success: true,
    data: tickets
  });
});
