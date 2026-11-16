// Se ejecuta antes de cargar cualquier módulo en cada archivo de test.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST || 'postgresql://ideator:ideator@localhost:5433/ideator_test?schema=public';
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'http://localhost:3001';
// Nunca llamar al LLM real desde los tests.
process.env.AZURE_OPENAI_API_KEY = '';
process.env.AZURE_OPENAI_BASE_URL = '';
process.env.ANTHROPIC_FOUNDRY_API_KEY = '';
process.env.ANTHROPIC_FOUNDRY_RESOURCE = '';
process.env.ANTHROPIC_FOUNDRY_BASE_URL = '';
