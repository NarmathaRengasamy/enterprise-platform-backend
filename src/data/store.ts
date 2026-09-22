import { isDbConnected } from '../config/db.js';
import { escapeRegex } from '../utils/response.util.js';
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
  async getProducts(filters?: {
    categoryId?: string;
    category?: string;
    status?: string;
    search?: string;
    sort?: Record<string, 1 | -1>;
  }): Promise<Product[]> {
    const sort = filters?.sort ?? { createdAt: -1 };

    if (isDbConnected()) {
      const query: any = {};
      /* categoryId is the real reference; the name filter stays for older clients. */
      if (filters?.categoryId) {
        query.categoryId = filters.categoryId;
      } else if (filters?.category && filters.category !== 'all' && filters.category !== 'All') {
        query.category = filters.category;
      }
      if (filters?.status && filters.status !== 'all' && filters.status !== 'All') {
        query.stockStatus = filters.status;
      }
      if (filters?.search) {
        const regex = new RegExp(escapeRegex(filters.search), 'i');
        query.$or = [{ name: regex }, { sku: regex }, { category: regex }];
      }

      /* An empty result is a legitimate answer — the old code fell through to the
         seed array whenever the query matched nothing, so a filter that excluded
         everything silently returned stale demo data. */
      return (await ProductModel.find(query).sort(sort).lean()) as any;
    }

    let result = [...this.products];
    if (filters?.categoryId) {
      result = result.filter((p) => p.categoryId === filters.categoryId);
    } else if (filters?.category && filters.category !== 'all' && filters.category !== 'All') {
      result = result.filter((p) => p.category?.toLowerCase() === filters.category!.toLowerCase());
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
          (p.category || '').toLowerCase().includes(q)
      );
    }

    const [field, direction] = Object.entries(sort)[0] ?? ['createdAt', -1];
    return result.sort((a: any, b: any) => {
      const av = a[field];
      const bv = b[field];
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (direction === 1 ? 1 : -1);
    });
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
    }
    this.products.unshift(product);
    /* productsCount is derived from the products collection on read, so there is
       no stored counter to keep in step any more. */
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
      if (doc) return true;
    }
    const index = this.products.findIndex((p) => p.id === id);
    if (index === -1) return false;
    this.products.splice(index, 1);
    return true;
  }

  /**
   * Rewrites the denormalised category name on every product pointing at this
   * category, so a rename cannot leave the two views disagreeing.
   */
  async renameProductCategory(categoryId: string, name: string): Promise<number> {
    if (isDbConnected()) {
      const res = await ProductModel.updateMany({ categoryId }, { category: name });
      return res.modifiedCount ?? 0;
    }
    let touched = 0;
    this.products = this.products.map((p) => {
      if (p.categoryId !== categoryId) return p;
      touched += 1;
      return { ...p, category: name };
    });
    return touched;
  }

  /**
   * Gives existing products the categoryId foreign key by matching their old
   * free-text category name to a real category. Idempotent: only rows still
   * missing the key are touched, so it is safe on every boot.
   */
  async backfillProductCategoryIds(): Promise<{ linked: number; orphans: string[] }> {
    const categories = await this.getCategories();
    const byName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));
    const orphans: string[] = [];
    let linked = 0;

    if (isDbConnected()) {
      const pending = await ProductModel.find({
        $or: [{ categoryId: { $exists: false } }, { categoryId: '' }, { categoryId: null }],
      }).lean();

      for (const product of pending as any[]) {
        const match = byName.get(String(product.category ?? '').trim().toLowerCase());
        if (!match) {
          orphans.push(`${product.id} (category "${product.category}")`);
          continue;
        }
        await ProductModel.updateOne(
          { id: product.id },
          { categoryId: match.id, category: match.name, categoryCode: match.id }
        );
        linked += 1;
      }
      return { linked, orphans };
    }

    this.products = this.products.map((p) => {
      if (p.categoryId) return p;
      const match = byName.get(String(p.category ?? '').trim().toLowerCase());
      if (!match) {
        orphans.push(`${p.id} (category "${p.category}")`);
        return p;
      }
      linked += 1;
      return { ...p, categoryId: match.id, category: match.name, categoryCode: match.id };
    });
    return { linked, orphans };
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
    /* Inclusive range — the Week view needs 7 days and Month up to 42, so a
       single exact dateKey forced the client to fetch the whole collection. */
    dateFrom?: string;
    dateTo?: string;
    participantType?: string;
    status?: string;
  }): Promise<ScheduleEvent[]> {
    if (isDbConnected()) {
      const query: any = {};
      if (filters?.dateKey) {
        query.dateKey = filters.dateKey;
      } else if (filters?.dateFrom || filters?.dateTo) {
        query.dateKey = {};
        if (filters.dateFrom) query.dateKey.$gte = filters.dateFrom;
        if (filters.dateTo) query.dateKey.$lte = filters.dateTo;
      }
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
    } else if (filters?.dateFrom || filters?.dateTo) {
      result = result.filter(
        (e) =>
          (!filters.dateFrom || e.dateKey >= filters.dateFrom) &&
          (!filters.dateTo || e.dateKey <= filters.dateTo)
      );
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
    const [products, categories, conversations, scheduleEvents, users, agents] = await Promise.all([
      this.getProducts(),
      this.getCategories(),
      this.getConversations(),
      this.getScheduleEvents(),
      this.getUsers(),
      this.getAgents(),
    ]);

    const totalProducts = products.length;
    const productsInStock = products.filter((p) => p.stockStatus === 'In Stock').length;
    const productsLowStock = products.filter((p) => p.stockStatus === 'Low Stock').length;
    const totalConversations = conversations.length;
    const unreadConversations = conversations.filter((c) => (c.unread || 0) > 0).length;
    const totalAppointments = scheduleEvents.length;
    const upcomingAppointments = scheduleEvents.filter((e) => e.status === 'Confirmed').length;
    const activeAgents = agents.filter((a) => a.status === 'Active').length;

    return {
      /* The cards also need category and team counts, and a server clock so the
         header stops hardcoding "Today: 12 Sep 2026". */
      totalCategories: categories.length,
      totalTeamMembers: users.length,
      activeTeamMembers: users.filter((u) => u.status === 'Active').length,
      confirmedAppointments: upcomingAppointments,
      serverDate: new Date().toISOString(),
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
