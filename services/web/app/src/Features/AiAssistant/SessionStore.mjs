import { db, ObjectId } from '../../infrastructure/mongodb.mjs'

// Wrap ObjectId() so a malformed id from the request raises a typed
// error the controller can translate to HTTP 400 instead of crashing
// the request with a 500.
function oid(value, field) {
  try {
    return new ObjectId(value)
  } catch {
    const err = new Error(`invalid_${field}`)
    err.code = 'INVALID_ID'
    throw err
  }
}

export default {
  async create(userId, projectId, title) {
    const doc = {
      userId: oid(userId, 'user_id'),
      projectId: oid(projectId, 'project_id'),
      title: title || 'New conversation',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const { insertedId } = await db.aiAssistantSessions.insertOne(doc)
    return { id: insertedId.toString(), ...doc, _id: insertedId }
  },

  async list(userId, projectId) {
    const docs = await db.aiAssistantSessions
      .find({
        userId: oid(userId, 'user_id'),
        projectId: oid(projectId, 'project_id'),
      })
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray()
    return docs.map(d => ({
      id: d._id.toString(),
      title: d.title,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))
  },

  // update / remove always require BOTH the userId AND the projectId in
  // the filter. Without projectId in the filter a user with one
  // project's sessionId could rename/delete sessions belonging to
  // another of their projects via the per-project route — the route
  // middleware only proves they can read THIS project, not that the
  // session belongs to it.
  async update(sessionId, userId, projectId, updates) {
    const filter = {
      _id: oid(sessionId, 'session_id'),
      userId: oid(userId, 'user_id'),
      projectId: oid(projectId, 'project_id'),
    }
    const $set = { updatedAt: new Date() }
    if (updates.title != null) $set.title = updates.title
    const r = await db.aiAssistantSessions.updateOne(filter, { $set })
    return r.matchedCount > 0
  },

  async remove(sessionId, userId, projectId) {
    const r = await db.aiAssistantSessions.deleteOne({
      _id: oid(sessionId, 'session_id'),
      userId: oid(userId, 'user_id'),
      projectId: oid(projectId, 'project_id'),
    })
    return r.deletedCount > 0
  },

  async findById(sessionId) {
    return db.aiAssistantSessions.findOne({
      _id: oid(sessionId, 'session_id'),
    })
  },
}