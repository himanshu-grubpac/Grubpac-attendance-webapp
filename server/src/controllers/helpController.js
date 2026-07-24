import {
  createHelpCommentSchema,
  createHelpTicketSchema,
  helpTicketQuerySchema,
  updateHelpTicketStatusSchema,
} from '../../../shared/validation/help.js';
import {
  addHelpComment,
  createHelpTicket,
  getHelpTicketById,
  listHelpTickets,
  updateHelpTicketStatus,
} from '../services/helpService.js';

export async function createTicketHandler(req, res) {
  const parsed = createHelpTicketSchema.parse(req.body);
  const ticket = await createHelpTicket(req.user, parsed);
  res.status(201).json({ ticket });
}

export async function listTicketsHandler(req, res) {
  const parsed = helpTicketQuerySchema.parse(req.query);
  const result = await listHelpTickets(req.user, req.userPermissions, parsed);
  res.json(result);
}

export async function getTicketHandler(req, res) {
  const result = await getHelpTicketById(req.params.id, req.user, req.userPermissions);
  res.json(result);
}

export async function updateTicketStatusHandler(req, res) {
  const parsed = updateHelpTicketStatusSchema.parse(req.body);
  const ticket = await updateHelpTicketStatus(
    req.params.id,
    req.user,
    req.userPermissions,
    parsed,
  );
  res.json({ ticket });
}

export async function addCommentHandler(req, res) {
  const parsed = createHelpCommentSchema.parse(req.body);
  const comment = await addHelpComment(
    req.params.id,
    req.user,
    req.userPermissions,
    parsed,
  );
  res.status(201).json({ comment });
}
