// src/routes/notifications.js
const express = require("express");
const router = express.Router();

const { requireAuth } = require("../utils/auth");
const {
  getNotificationPreferences,
  updateNotificationPreferences,
} = require("../utils/notifications");

// GET /api/notifications/preferences
router.get("/preferences", requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;

    const prefs = await getNotificationPreferences(userId);

    // el front espera { preferences: { ... } }
    return res.json({ preferences: prefs });
  } catch (e) {
    console.error("GET /api/notifications/preferences error", e);
    return res
      .status(500)
      .json({ error: "No se pudieron obtener las preferencias" });
  }
});

// PUT /api/notifications/preferences
router.put("/preferences", requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;

    const updated = await updateNotificationPreferences(userId, req.body || {});

    return res.json({ ok: true, preferences: updated });
  } catch (e) {
    console.error("PUT /api/notifications/preferences error", e);
    return res
      .status(500)
      .json({ error: "No se pudieron actualizar las preferencias" });
  }
});

module.exports = router;
