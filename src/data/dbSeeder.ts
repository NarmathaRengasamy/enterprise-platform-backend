import { isDbConnected } from '../config/db.js';
import { UserModel } from '../models/User.model.js';
import { ProductModel } from '../models/Product.model.js';
import { CategoryModel } from '../models/Category.model.js';
import { ConversationModel } from '../models/Conversation.model.js';
import { ScheduleEventModel } from '../models/ScheduleEvent.model.js';
import { AIAgentModel } from '../models/Agent.model.js';
import { WebhookEndpointModel } from '../models/Endpoint.model.js';
import {
  INITIAL_USERS,
  INITIAL_PRODUCTS,
  INITIAL_CATEGORIES,
  INITIAL_CONVERSATIONS,
  INITIAL_SCHEDULE_EVENTS,
  INITIAL_DEVELOPER_AGENTS,
  INITIAL_DEVELOPER_ENDPOINTS,
} from './seedData.js';

export const seedDatabase = async (): Promise<void> => {
  if (!isDbConnected()) {
    console.log('ℹ️ [DB Seeder] Skipping MongoDB seeding (Database not connected).');
    return;
  }

  try {
    const userCount = await UserModel.countDocuments();
    if (userCount === 0) {
      await UserModel.insertMany(INITIAL_USERS);
      console.log(`🌱 [DB Seeder] Inserted ${INITIAL_USERS.length} default users into MongoDB.`);
    }

    const productCount = await ProductModel.countDocuments();
    if (productCount === 0) {
      await ProductModel.insertMany(INITIAL_PRODUCTS);
      console.log(`🌱 [DB Seeder] Inserted ${INITIAL_PRODUCTS.length} default products into MongoDB.`);
    }

    const categoryCount = await CategoryModel.countDocuments();
    if (categoryCount === 0) {
      await CategoryModel.insertMany(INITIAL_CATEGORIES);
      console.log(`🌱 [DB Seeder] Inserted ${INITIAL_CATEGORIES.length} default categories into MongoDB.`);
    }

    const convoCount = await ConversationModel.countDocuments();
    if (convoCount === 0) {
      await ConversationModel.insertMany(INITIAL_CONVERSATIONS);
      console.log(`🌱 [DB Seeder] Inserted ${INITIAL_CONVERSATIONS.length} default conversations into MongoDB.`);
    }

    const eventCount = await ScheduleEventModel.countDocuments();
    if (eventCount === 0) {
      await ScheduleEventModel.insertMany(INITIAL_SCHEDULE_EVENTS);
      console.log(`🌱 [DB Seeder] Inserted ${INITIAL_SCHEDULE_EVENTS.length} default schedule events into MongoDB.`);
    }

    const agentCount = await AIAgentModel.countDocuments();
    if (agentCount === 0) {
      await AIAgentModel.insertMany(INITIAL_DEVELOPER_AGENTS);
      console.log(`🌱 [DB Seeder] Inserted ${INITIAL_DEVELOPER_AGENTS.length} default AI agents into MongoDB.`);
    }

    const endpointCount = await WebhookEndpointModel.countDocuments();
    if (endpointCount === 0) {
      await WebhookEndpointModel.insertMany(INITIAL_DEVELOPER_ENDPOINTS);
      console.log(`🌱 [DB Seeder] Inserted ${INITIAL_DEVELOPER_ENDPOINTS.length} default webhook endpoints into MongoDB.`);
    }
  } catch (err: any) {
    console.error('❌ [DB Seeder Error]:', err.message);
  }
};
