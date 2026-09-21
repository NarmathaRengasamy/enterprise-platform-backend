import { isDbConnected } from '../config/db.js';
import { UserModel } from '../models/User.model.js';
import { ProductModel } from '../models/Product.model.js';
import { CategoryModel } from '../models/Category.model.js';
import { ConversationModel } from '../models/Conversation.model.js';
import { ScheduleEventModel } from '../models/ScheduleEvent.model.js';
import { ArticleModel } from '../models/Article.model.js';
import { CollectionModel } from '../models/Collection.model.js';
import { AIAgentModel } from '../models/Agent.model.js';
import { WebhookEndpointModel } from '../models/Endpoint.model.js';
import {
  User,
  Product,
  Category,
  Conversation,
  Message,
  ScheduleEvent,
  Article,
  Collection,
  AIAgent,
  WebhookEndpoint,
  DashboardMetrics,
} from '../types/index.js';
import {
  INITIAL_USERS,
  INITIAL_PRODUCTS,
  INITIAL_CATEGORIES,
  INITIAL_CONVERSATIONS,
  INITIAL_SCHEDULE_EVENTS,
  INITIAL_ARTICLES,
  INITIAL_COLLECTIONS,
  INITIAL_DEVELOPER_AGENTS,
  INITIAL_DEVELOPER_ENDPOINTS,
} from './seedData.js';

class DataStore {
  // In-memory cache & fallback store
  private users: User[] = [...INITIAL_USERS];
  private products: Product[] = [...INITIAL_PRODUCTS];
  private categories: Category[] = [...INITIAL_CATEGORIES];
  private conversations: Conversation[] = [...INITIAL_CONVERSATIONS];
  private scheduleEvents: ScheduleEvent[] = [...INITIAL_SCHEDULE_EVENTS];
  private articles: Article[] = [...INITIAL_ARTICLES];
  private collections: Collection[] = [...INITIAL_COLLECTIONS];
  private agents: AIAgent[] = [...INITIAL_DEVELOPER_AGENTS];
  private endpoints: WebhookEndpoint[] = [...INITIAL_DEVELOPER_ENDPOINTS];

  // ================= USERS =================
  async getUsers(): Promise<User[]> {
    if (isDbConnected()) {
      const docs = await UserModel.find().lean();
      if (docs && docs.length > 0) return docs as any;
    }
    return this.users;
  }

  async getUserById(id: string): Promise<User | undefined> {
    if (isDbConnected()) {
      const doc = await UserModel.findOne({ id }).lean();
      if (doc) return doc as any;
    }
    return this.users.find((u) => u.id === id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    if (isDbConnected()) {
      const doc = await UserModel.findOne({ email: email.toLowerCase() }).select('+password').lean();
      if (doc) return doc as any;
    }
    return this.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  }

  async createUser(user: User): Promise<User> {
    if (isDbConnected()) {
      await UserModel.create(user);
    }
    this.users.push(user);
    return user;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    if (isDbConnected()) {
      const updated = await UserModel.findOneAndUpdate({ id }, updates, { new: true }).lean();
      if (updated) return updated as any;
    }
    const index = this.users.findIndex((u) => u.id === id);
    if (index === -1) return undefined;
    this.users[index] = { ...this.users[index], ...updates, updatedAt: new Date().toISOString() };
    return this.users[index];
  }

  async deleteUser(id: string): Promise<boolean> {
    if (isDbConnected()) {
      const res = await UserModel.deleteOne({ id });
      return res.deletedCount > 0;
    }
    const initialLen = this.users.length;
    this.users = this.users.filter((u) => u.id !== id);
    return this.users.length < initialLen;
  }

  // ================= PRODUCTS =================
  async getProducts(filters?: { category?: string; status?: string; search?: string }): Promise<Product[]> {
    if (isDbConnected()) {
      const query: any = {};
      if (filters?.category && filters.category !== 'all' && filters.category !== 'All') {
        query.$or = [
          { category: { $regex: filters.category, $options: 'i' } },
          { categoryCode: { $regex: filters.category, $options: 'i' } },
        ];
      }
      if (filters?.status && filters.status !== 'all' && filters.status !== 'All') {
        query.stockStatus = { $regex: filters.status, $options: 'i' };
      }
      if (filters?.search) {
        const regex = new RegExp(filters.search, 'i');
        query.$or = [{ name: regex }, { sku: regex }, { description: regex }];
      }

      const docs = await ProductModel.find(query).sort({ createdAt: -1 }).lean();
      if (docs && docs.length > 0) return docs as any;
    }

    let result = [...this.products];
    if (filters?.category && filters.category !== 'all' && filters.category !== 'All') {
      result = result.filter(
        (p) =>
          p.category.toLowerCase() === filters.category!.toLowerCase() ||
          p.categoryCode?.toLowerCase() === filters.category!.toLowerCase()
      );
    }
    if (filters?.status && filters.status !== 'all' && filters.status !== 'All') {
      result = result.filter((p) => p.stockStatus.toLowerCase() === filters.status!.toLowerCase());
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q)
      );
    }
    return result;
  }

  async getProductById(id: string): Promise<Product | undefined> {
    if (isDbConnected()) {
      const doc = await ProductModel.findOne({ id }).lean();
      if (doc) return doc as any;
    }
    return this.products.find((p) => p.id === id);
  }

  async createProduct(product: Product): Promise<Product> {
    if (isDbConnected()) {
      await ProductModel.create(product);
      await CategoryModel.updateOne(
        { $or: [{ id: product.categoryCode }, { name: product.category }] },
        { $inc: { productsCount: 1 } }
      );
    }
    this.products.unshift(product);
    const cat = this.categories.find(
      (c) =>
        c.id.toLowerCase() === product.categoryCode.toLowerCase() ||
        c.name.toLowerCase() === product.category.toLowerCase()
    );
    if (cat) cat.productsCount += 1;
    return product;
  }

  async updateProduct(id: string, updates: Partial<Product>): Promise<Product | undefined> {
    if (isDbConnected()) {
      const updated = await ProductModel.findOneAndUpdate({ id }, updates, { new: true }).lean();
      if (updated) return updated as any;
    }
    const index = this.products.findIndex((p) => p.id === id);
    if (index === -1) return undefined;
    this.products[index] = { ...this.products[index], ...updates, updatedAt: new Date().toISOString() };
    return this.products[index];
  }

  async deleteProduct(id: string): Promise<boolean> {
    if (isDbConnected()) {
      const doc = await ProductModel.findOneAndDelete({ id }).lean();
      if (doc) {
        await CategoryModel.updateOne(
          { $or: [{ id: (doc as any).categoryCode }, { name: (doc as any).category }] },
          { $inc: { productsCount: -1 } }
        );
        return true;
      }
    }
    const index = this.products.findIndex((p) => p.id === id);
    if (index === -1) return false;
    const removed = this.products.splice(index, 1)[0];
    const cat = this.categories.find(
      (c) =>
        c.id.toLowerCase() === removed.categoryCode.toLowerCase() ||
        c.name.toLowerCase() === removed.category.toLowerCase()
    );
    if (cat && cat.productsCount > 0) cat.productsCount -= 1;
    return true;
  }

  // ================= CATEGORIES =================
  async getCategories(search?: string): Promise<Category[]> {
    if (isDbConnected()) {
      const query: any = {};
      if (search) {
        const regex = new RegExp(search, 'i');
        query.$or = [{ name: regex }, { description: regex }, { id: regex }];
      }
      const docs = await CategoryModel.find(query).sort({ name: 1 }).lean();
      if (docs && docs.length > 0) return docs as any;
    }

    if (!search) return this.categories;
    const q = search.toLowerCase();
    return this.categories.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
    );
  }

  async getCategoryById(id: string): Promise<Category | undefined> {
    if (isDbConnected()) {
      const doc = await CategoryModel.findOne({ id }).lean();
      if (doc) return doc as any;
    }
    return this.categories.find((c) => c.id.toLowerCase() === id.toLowerCase());
  }

  async createCategory(category: Category): Promise<Category> {
    if (isDbConnected()) {
      await CategoryModel.create(category);
    }
    this.categories.unshift(category);
    return category;
  }

  async updateCategory(id: string, updates: Partial<Category>): Promise<Category | undefined> {
    if (isDbConnected()) {
      const updated = await CategoryModel.findOneAndUpdate({ id }, updates, { new: true }).lean();
      if (updated) return updated as any;
    }
    const index = this.categories.findIndex((c) => c.id.toLowerCase() === id.toLowerCase());
    if (index === -1) return undefined;
    this.categories[index] = { ...this.categories[index], ...updates };
    return this.categories[index];
  }

  async deleteCategory(id: string): Promise<boolean> {
    if (isDbConnected()) {
      const res = await CategoryModel.deleteOne({ id });
      return res.deletedCount > 0;
    }
    const initialLen = this.categories.length;
    this.categories = this.categories.filter((c) => c.id.toLowerCase() !== id.toLowerCase());
    return this.categories.length < initialLen;
  }

  // ================= CONVERSATIONS =================
  async getConversations(filters?: { channel?: string; search?: string }): Promise<Conversation[]> {
    if (isDbConnected()) {
      const query: any = {};
      if (filters?.channel && filters.channel !== 'all') {
        query.channel = filters.channel;
      }
      if (filters?.search) {
        const regex = new RegExp(filters.search, 'i');
        query.$or = [{ name: regex }, { lastMessage: regex }];
      }
      const docs = await ConversationModel.find(query).sort({ updatedAt: -1 }).lean();
      if (docs && docs.length > 0) return docs as any;
    }

    let result = [...this.conversations];
    if (filters?.channel && filters.channel !== 'all') {
      result = result.filter((c) => c.channel === filters.channel);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (c) => c.name.toLowerCase().includes(q) || c.lastMessage.toLowerCase().includes(q)
      );
    }
    return result;
  }

  async upsertConversations(convos: Conversation[]): Promise<void> {
    if (isDbConnected() && convos.length > 0) {
      const ops = convos.map((c) => ({
        updateOne: {
          filter: { id: c.id },
          update: { $set: c },
          upsert: true,
        },
      }));
      await ConversationModel.bulkWrite(ops);
    }

    // Also update in-memory cache
    convos.forEach((c) => {
      const idx = this.conversations.findIndex((existing) => existing.id === c.id);
      if (idx !== -1) {
        this.conversations[idx] = { ...this.conversations[idx], ...c };
      } else {
        this.conversations.push(c);
      }
    });
  }

  async getConversationById(id: string): Promise<Conversation | undefined> {
    if (isDbConnected()) {
      const doc = await ConversationModel.findOne({ id }).lean();
      if (doc) return doc as any;
    }
    return this.conversations.find((c) => c.id === id);
  }

  async createConversation(conversation: Conversation): Promise<Conversation> {
    if (isDbConnected()) {
      await ConversationModel.create(conversation);
    }
    this.conversations.unshift(conversation);
    return conversation;
  }

  async addMessageToConversation(convoId: string, message: Message): Promise<Conversation | undefined> {
    if (isDbConnected()) {
      const updated = await ConversationModel.findOneAndUpdate(
        { id: convoId },
        {
          $push: { messages: message },
          $set: { lastMessage: message.text, timestamp: message.time },
        },
        { new: true }
      ).lean();
      if (updated) return updated as any;
    }

    const index = this.conversations.findIndex((c) => c.id === convoId);
    if (index === -1) return undefined;

    const convo = this.conversations[index];
    const updatedMessages = [...convo.messages, message];
    const updatedConvo: Conversation = {
      ...convo,
      messages: updatedMessages,
      lastMessage: message.text,
      timestamp: message.time,
    };
    this.conversations[index] = updatedConvo;
    return updatedConvo;
  }

  async markConversationAsRead(convoId: string): Promise<Conversation | undefined> {
    if (isDbConnected()) {
      const updated = await ConversationModel.findOneAndUpdate(
        { id: convoId },
        { $set: { unread: 0 } },
        { new: true }
      ).lean();
      if (updated) return updated as any;
    }

    const index = this.conversations.findIndex((c) => c.id === convoId);
    if (index === -1) return undefined;
    this.conversations[index] = { ...this.conversations[index], unread: 0 };
    return this.conversations[index];
  }

  // ================= SCHEDULE / APPOINTMENTS =================
  async getScheduleEvents(filters?: {
    dateKey?: string;
    participantType?: string;
    status?: string;
  }): Promise<ScheduleEvent[]> {
    if (isDbConnected()) {
      const query: any = {};
      if (filters?.dateKey) query.dateKey = filters.dateKey;
      if (filters?.participantType && filters.participantType !== 'all') {
        query.participantType = filters.participantType;
      }
      if (filters?.status && filters.status !== 'all') {
        query.status = filters.status;
      }
      const docs = await ScheduleEventModel.find(query).sort({ dateKey: 1, startTime: 1 }).lean();
      if (docs && docs.length > 0) return docs as any;
    }

    let result = [...this.scheduleEvents];
    if (filters?.dateKey) {
      result = result.filter((e) => e.dateKey === filters.dateKey);
    }
    if (filters?.participantType && filters.participantType !== 'all') {
      result = result.filter((e) => e.participantType === filters.participantType);
    }
    if (filters?.status && filters.status !== 'all') {
      result = result.filter((e) => e.status.toLowerCase() === filters.status!.toLowerCase());
    }
    return result;
  }

  async getScheduleEventById(id: string): Promise<ScheduleEvent | undefined> {
    if (isDbConnected()) {
      const doc = await ScheduleEventModel.findOne({ id }).lean();
      if (doc) return doc as any;
    }
    return this.scheduleEvents.find((e) => e.id === id);
  }

  async createScheduleEvent(event: ScheduleEvent): Promise<ScheduleEvent> {
    if (isDbConnected()) {
      await ScheduleEventModel.create(event);
    }
    this.scheduleEvents.push(event);
    return event;
  }

  async updateScheduleEvent(id: string, updates: Partial<ScheduleEvent>): Promise<ScheduleEvent | undefined> {
    if (isDbConnected()) {
      const updated = await ScheduleEventModel.findOneAndUpdate({ id }, updates, { new: true }).lean();
      if (updated) return updated as any;
    }
    const index = this.scheduleEvents.findIndex((e) => e.id === id);
    if (index === -1) return undefined;
    this.scheduleEvents[index] = { ...this.scheduleEvents[index], ...updates };
    return this.scheduleEvents[index];
  }

  async deleteScheduleEvent(id: string): Promise<boolean> {
    if (isDbConnected()) {
      const res = await ScheduleEventModel.deleteOne({ id });
      return res.deletedCount > 0;
    }
    const initialLen = this.scheduleEvents.length;
    this.scheduleEvents = this.scheduleEvents.filter((e) => e.id !== id);
    return this.scheduleEvents.length < initialLen;
  }

  // ================= KNOWLEDGE BASE =================
  async getArticles(filters?: { category?: string; search?: string }): Promise<Article[]> {
    if (isDbConnected()) {
      const query: any = {};
      if (filters?.category && filters.category !== 'All') {
        query.category = { $regex: filters.category, $options: 'i' };
      }
      if (filters?.search) {
        const regex = new RegExp(filters.search, 'i');
        query.$or = [{ title: regex }, { content: regex }, { category: regex }];
      }
      const docs = await ArticleModel.find(query).sort({ updatedAt: -1 }).lean();
      if (docs && docs.length > 0) return docs as any;
    }

    let result = [...this.articles];
    if (filters?.category && filters.category !== 'All') {
      result = result.filter((a) => a.category.toLowerCase() === filters.category!.toLowerCase());
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.content.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q)
      );
    }
    return result;
  }

  async getArticleById(id: string): Promise<Article | undefined> {
    if (isDbConnected()) {
      const doc = await ArticleModel.findOne({ id }).lean();
      if (doc) return doc as any;
    }
    return this.articles.find((a) => a.id === id);
  }

  async createArticle(article: Article): Promise<Article> {
    if (isDbConnected()) {
      await ArticleModel.create(article);
    }
    this.articles.unshift(article);
    return article;
  }

  async updateArticle(id: string, updates: Partial<Article>): Promise<Article | undefined> {
    if (isDbConnected()) {
      const updated = await ArticleModel.findOneAndUpdate({ id }, updates, { new: true }).lean();
      if (updated) return updated as any;
    }
    const index = this.articles.findIndex((a) => a.id === id);
    if (index === -1) return undefined;
    this.articles[index] = { ...this.articles[index], ...updates };
    return this.articles[index];
  }

  async deleteArticle(id: string): Promise<boolean> {
    if (isDbConnected()) {
      const res = await ArticleModel.deleteOne({ id });
      return res.deletedCount > 0;
    }
    const initialLen = this.articles.length;
    this.articles = this.articles.filter((a) => a.id !== id);
    return this.articles.length < initialLen;
  }

  async getCollections(): Promise<Collection[]> {
    if (isDbConnected()) {
      const docs = await CollectionModel.find().sort({ name: 1 }).lean();
      if (docs && docs.length > 0) return docs as any;
    }
    return this.collections;
  }

  async createCollection(collection: Collection): Promise<Collection> {
    if (isDbConnected()) {
      await CollectionModel.create(collection);
    }
    this.collections.push(collection);
    return collection;
  }

  // ================= DEVELOPER & AI AGENTS =================
  async getAgents(): Promise<AIAgent[]> {
    if (isDbConnected()) {
      const docs = await AIAgentModel.find().sort({ createdAt: -1 }).lean();
      if (docs && docs.length > 0) return docs as any;
    }
    return this.agents;
  }

  async getAgentById(id: string): Promise<AIAgent | undefined> {
    if (isDbConnected()) {
      const doc = await AIAgentModel.findOne({ id }).lean();
      if (doc) return doc as any;
    }
    return this.agents.find((a) => a.id === id);
  }

  async createAgent(agent: AIAgent): Promise<AIAgent> {
    if (isDbConnected()) {
      await AIAgentModel.create(agent);
    }
    this.agents.push(agent);
    return agent;
  }

  async updateAgent(id: string, updates: Partial<AIAgent>): Promise<AIAgent | undefined> {
    if (isDbConnected()) {
      const updated = await AIAgentModel.findOneAndUpdate({ id }, updates, { new: true }).lean();
      if (updated) return updated as any;
    }
    const index = this.agents.findIndex((a) => a.id === id);
    if (index === -1) return undefined;
    this.agents[index] = { ...this.agents[index], ...updates };
    return this.agents[index];
  }

  async deleteAgent(id: string): Promise<boolean> {
    if (isDbConnected()) {
      const res = await AIAgentModel.deleteOne({ id });
      return res.deletedCount > 0;
    }
    const initialLen = this.agents.length;
    this.agents = this.agents.filter((a) => a.id !== id);
    return this.agents.length < initialLen;
  }

  async getEndpoints(): Promise<WebhookEndpoint[]> {
    if (isDbConnected()) {
      const docs = await WebhookEndpointModel.find().sort({ createdAt: -1 }).lean();
      if (docs && docs.length > 0) return docs as any;
    }
    return this.endpoints;
  }

  async getEndpointById(id: string): Promise<WebhookEndpoint | undefined> {
    if (isDbConnected()) {
      const doc = await WebhookEndpointModel.findOne({ id }).lean();
      if (doc) return doc as any;
    }
    return this.endpoints.find((e) => e.id === id);
  }

  async createEndpoint(endpoint: WebhookEndpoint): Promise<WebhookEndpoint> {
    if (isDbConnected()) {
      await WebhookEndpointModel.create(endpoint);
    }
    this.endpoints.push(endpoint);
    return endpoint;
  }

  async updateEndpoint(id: string, updates: Partial<WebhookEndpoint>): Promise<WebhookEndpoint | undefined> {
    if (isDbConnected()) {
      const updated = await WebhookEndpointModel.findOneAndUpdate({ id }, updates, { new: true }).lean();
      if (updated) return updated as any;
    }
    const index = this.endpoints.findIndex((e) => e.id === id);
    if (index === -1) return undefined;
    this.endpoints[index] = { ...this.endpoints[index], ...updates };
    return this.endpoints[index];
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    if (isDbConnected()) {
      const res = await WebhookEndpointModel.deleteOne({ id });
      return res.deletedCount > 0;
    }
    const initialLen = this.endpoints.length;
    this.endpoints = this.endpoints.filter((e) => e.id !== id);
    return this.endpoints.length < initialLen;
  }

  // ================= DASHBOARD METRICS =================
  async getDashboardMetrics(): Promise<DashboardMetrics> {
    const products = await this.getProducts();
    const conversations = await this.getConversations();
    const scheduleEvents = await this.getScheduleEvents();
    const agents = await this.getAgents();

    const totalProducts = products.length;
    const productsInStock = products.filter((p) => p.stockStatus === 'In Stock').length;
    const productsLowStock = products.filter((p) => p.stockStatus === 'Low Stock').length;
    const totalConversations = conversations.length;
    const unreadConversations = conversations.filter((c) => (c.unread || 0) > 0).length;
    const totalAppointments = scheduleEvents.length;
    const upcomingAppointments = scheduleEvents.filter((e) => e.status === 'Confirmed').length;
    const activeAgents = agents.filter((a) => a.status === 'Active').length;

    return {
      totalProducts,
      productsInStock,
      productsLowStock,
      totalConversations,
      unreadConversations,
      totalAppointments,
      upcomingAppointments,
      activeAgents,
      totalApiCalls: '271.1k',
      systemHealth: '99.98% Healthy',
    };
  }
}

export const store = new DataStore();
