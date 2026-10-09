// npm run seed — regenerate 30 days of demo data ending now.
import './env.js';
import { ensureFreshData } from './db.js';

ensureFreshData(true);
