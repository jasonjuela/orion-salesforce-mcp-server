import { Router } from 'express';
import { SessionStore } from '../config/sessionStore.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Handle clarification responses
 * POST /clarify
 * Body: { sessionId, question, answer: { object: "Account" } }
 */
router.post('/', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body;
    
    if (!sessionId || !question || !answer) {
      return res.status(400).json({ 
        error: 'Missing required fields: sessionId, question, answer' 
      });
    }
    
    if (!answer.object) {
      return res.status(400).json({ 
        error: 'Answer must contain an object field' 
      });
    }
    
    // Store the clarification answer
    SessionStore.addClarification(sessionId, question, answer);
    
    logger.info('Clarification answer stored', { 
      sessionId, 
      question: question.substring(0, 100), 
      object: answer.object 
    });
    
    res.json({ 
      success: true, 
      message: 'Clarification answer stored. You can now retry your question.' 
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to store clarification');
    res.status(500).json({ error: 'internal_error', message: err?.message });
  }
});

/**
 * Get clarification history for a session
 * GET /clarify/:sessionId
 */
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = SessionStore.get(sessionId);
    
    res.json({
      clarifications: session.clarifications || {},
      queryHistory: session.queryHistory?.slice(0, 10) || [],
      objectPreferences: session.objectPreferences || {}
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to get clarification history');
    res.status(500).json({ error: 'internal_error', message: err?.message });
  }
});

export default router;
