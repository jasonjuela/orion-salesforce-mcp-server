import { Router } from 'express';
import { 
  loadOrgProfile, 
  loadPersona, 
  saveOrgProfile, 
  savePersona, 
  listOrgProfiles, 
  listPersonas,
  clearConfigCache 
} from './configLoader.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /config/:orgId - Load org profile
 */
router.get('/config/:orgId', async (req, res) => {
  try {
    const orgId = req.params.orgId;
    const profile = await loadOrgProfile(orgId);
    res.json(profile);
  } catch (error) {
    logger.error('Failed to load org profile', { orgId: req.params.orgId, error: error.message });
    res.status(500).json({ error: 'config_load_error', message: error.message });
  }
});

/**
 * PUT /config/:orgId - Save org profile
 */
router.put('/config/:orgId', async (req, res) => {
  try {
    const orgId = req.params.orgId;
    const success = await saveOrgProfile(orgId, req.body);
    
    if (success) {
      res.json({ ok: true, message: 'Org profile saved successfully' });
    } else {
      res.status(500).json({ error: 'config_save_error', message: 'Failed to save org profile' });
    }
  } catch (error) {
    logger.error('Failed to save org profile', { orgId: req.params.orgId, error: error.message });
    res.status(500).json({ error: 'config_save_error', message: error.message });
  }
});

/**
 * GET /config - List all org profiles
 */
router.get('/config', async (req, res) => {
  try {
    const profiles = await listOrgProfiles();
    res.json({ profiles, count: profiles.length });
  } catch (error) {
    logger.error('Failed to list org profiles', { error: error.message });
    res.status(500).json({ error: 'config_list_error', message: error.message });
  }
});

/**
 * GET /personas/:name - Load persona
 */
router.get('/personas/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const persona = await loadPersona(name);
    res.json(persona);
  } catch (error) {
    logger.error('Failed to load persona', { name: req.params.name, error: error.message });
    res.status(500).json({ error: 'persona_load_error', message: error.message });
  }
});

/**
 * PUT /personas/:name - Save persona
 */
router.put('/personas/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const success = await savePersona(name, req.body);
    
    if (success) {
      res.json({ ok: true, message: 'Persona saved successfully' });
    } else {
      res.status(500).json({ error: 'persona_save_error', message: 'Failed to save persona' });
    }
  } catch (error) {
    logger.error('Failed to save persona', { name: req.params.name, error: error.message });
    res.status(500).json({ error: 'persona_save_error', message: error.message });
  }
});

/**
 * GET /personas - List all personas
 */
router.get('/personas', async (req, res) => {
  try {
    const personas = await listPersonas();
    res.json({ personas, count: personas.length });
  } catch (error) {
    logger.error('Failed to list personas', { error: error.message });
    res.status(500).json({ error: 'persona_list_error', message: error.message });
  }
});

/**
 * POST /config/cache/clear - Clear configuration cache
 */
router.post('/config/cache/clear', async (req, res) => {
  try {
    clearConfigCache();
    res.json({ ok: true, message: 'Configuration cache cleared successfully' });
  } catch (error) {
    logger.error('Failed to clear config cache', { error: error.message });
    res.status(500).json({ error: 'cache_clear_error', message: error.message });
  }
});

export default router;


