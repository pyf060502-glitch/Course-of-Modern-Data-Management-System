import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errors.js';
import { parseObjectId } from '../validators/basic.js';
import { parsePagination } from './surveys.js';
import { createQuestionLibraryService, questionInput } from './question-library.js';

export function createNotificationService(db) {
  const notifications = db.collection('notifications');
  const library = createQuestionLibraryService(db);
  const filter = (id, userId) => ({ _id: parseObjectId(id, 'notificationId'),
    recipientId: parseObjectId(String(userId), 'userId') });
  async function owned(id, userId) {
    const notification = await notifications.findOne(filter(id, userId));
    if (!notification) throw new HttpError(404, 'NOT_FOUND', 'Notification not found');
    return notification;
  }
  const conflict = () => new HttpError(409, 'NOTIFICATION_BUSY', 'Notification is being processed; retry shortly');
  return {
    async count(userId) {
      const recipientId = parseObjectId(String(userId), 'userId');
      const pendingCount = await notifications.countDocuments({ recipientId, status: { $in: ['pending', 'accepting'] } });
      return { pendingCount };
    },
    async list(userId, query) {
      const { page, pageSize } = parsePagination(query);
      const recipientId = parseObjectId(String(userId), 'userId');
      const total = await notifications.countDocuments({ recipientId });
      const records = await notifications.find({ recipientId }).sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize).limit(pageSize).toArray();
      return { items: records.map((record) => ({ id: String(record._id), senderUsername: record.senderUsername,
        question: record.question, status: record.status, createdAt: record.createdAt,
        acceptedAt: record.acceptedAt ?? null,
        canAccept: record.status === 'pending'
          || (record.status === 'accepting' && record.leaseUntil <= new Date()),
      })), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
    },
    async accept(id, userId) {
      const identity = filter(id, userId);
      const now = new Date();
      const operationId = randomUUID();
      const notification = await notifications.findOneAndUpdate({ ...identity, $or: [
        { status: 'pending' }, { status: 'accepting', leaseUntil: { $lte: now } },
      ] }, { $set: { status: 'accepting', operationId, leaseUntil: new Date(now.getTime() + 30000) } },
      { returnDocument: 'after' });
      if (!notification) {
        const current = await owned(id, userId);
        if (current.status === 'accepted') return { accepted: true };
        throw conflict();
      }
      const operation = { ...identity, status: 'accepting', operationId };
      try {
        await library.create(userId, { question: questionInput(notification.question) }, { origin: notification.origin ?? {
          kind: 'shared', senderUsername: notification.senderUsername, title: notification.question.title, version: 1,
        } });
        const updated = await notifications.updateOne(operation, {
          $set: { status: 'accepted', acceptedAt: new Date() }, $unset: { operationId: '', leaseUntil: '' },
        });
        if (!updated.matchedCount) throw conflict();
        return { accepted: true };
      } catch (error) {
        await notifications.updateOne(operation, {
          $set: { status: 'pending' }, $unset: { operationId: '', leaseUntil: '' },
        });
        throw error;
      }
    },
    async delete(id, userId) {
      const deleted = await notifications.deleteOne({ ...filter(id, userId), status: { $in: ['pending', 'accepted'] } });
      if (!deleted.deletedCount) { await owned(id, userId); throw conflict(); }
      return { deleted: true };
    },
  };
}
