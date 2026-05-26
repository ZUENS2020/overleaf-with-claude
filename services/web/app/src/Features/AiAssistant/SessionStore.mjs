import { db, ObjectId } from '../../infrastructure/mongodb.mjs'

const SESSIONS = 'aiAssistantSessions'

function coll() {
  return db.collection(SESSIONS)
}

export default {
  async create(userId, projectId, title) {
    const doc = {
      userId: new ObjectId(userId),
      projectId: new ObjectId(projectId),
      title: title || 'New conversation',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const { insertedId } = await coll().insertOne(doc)
    return { id: insertedId.toString(), ...doc, _id: insertedId }
  },

  async list(userId, projectId) {
    const docs = await coll()
      .find({
        userId: new ObjectId(userId),
        projectId: new ObjectId(projectId),
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

  async update(sessionId, userId, updates) {
    const filter = {
      _id: new ObjectId(sessionId),
      userId: new ObjectId(userId),
    }
    const $set = { updatedAt: new Date() }
    if (updates.title != null) $set.title = updates.title
    await coll().updateOne(filter, { $set })
  },

  async remove(sessionId, userId) {
    await coll().deleteOne({
      _id: new ObjectId(sessionId),
      userId: new ObjectId(userId),
    })
  },

  async findById(sessionId) {
    return coll().findOne({ _id: new ObjectId(sessionId) })
  },
}