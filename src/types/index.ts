// Core Domain Types for Enterprise Platform Backend

export type Role = 'Admin' | 'Editor' | 'Viewer';
export type MemberStatus = 'Active' | 'Pending' | 'Inactive';

export interface User {
  id: string;
  name: string;
  email: string;
  password?: string;
  role: Role;
  department: string;
  status: MemberStatus;
  avatar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUserResponse {
  id: string;
  name: string;
  email: string;
  role: Role;
  department: string;
  status: MemberStatus;
  avatar?: string;
}

export interface AuthTokenPayload {
  userId: string;
  email: string;
  role: Role;
}

export interface ProductGalleryItem {
  id: number;
  label: string;
  src: string;
}

export interface ProductVariant {
  option: string;
  value: string;
  price: number;
  stock: string;
  status: 'In Stock' | 'Low Stock' | 'Out of Stock';
}

export interface ProductVideo {
  id: number;
  duration: string;
  title: string;
  thumbnail: string;
}

export interface Product {
  id: string;
  name: string;
  shortName?: string;
  sku: string;
  /** Foreign key to Category.id. */
  categoryId: string;
  /** Display name, derived by the server from categoryId. */
  category: string;
  /** @deprecated mirror of categoryId */
  categoryCode: string;
  price: number;
  originalPrice?: number;
  stock: number;
  stockStatus: 'In Stock' | 'Low Stock' | 'Out of Stock';
  committed: number;
  reorderPoint: number;
  margin: string;
  discount?: string;
  image: string;
  gallery: ProductGalleryItem[];
  description: string;
  variants: ProductVariant[];
  videos: ProductVideo[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  productsCount: number;
  updated: string;
  icon: string;
  color: string;
}

export type ChannelType = 'whatsapp' | 'sms' | 'email' | 'voice' | 'web';

export interface MessageAttachment {
  title?: string;
  sku?: string;
  status?: string;
  image?: string;
  /** Signed and short-lived — render it, never store or cache it. */
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface Message {
  id: string;
  sender: 'me' | 'them' | 'system';
  actor?: string;
  eventType?: string;
  text: string;
  time: string;
  timestamp?: string;
  channel?: ChannelType | string;
  toolName?: string;
  /** Transport outcome only — the business result is in `toolOutput`. */
  toolStatus?: string;
  toolLatencyMs?: number;
  toolErrorDetail?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  attachment?: MessageAttachment;
}

export interface Conversation {
  id: string;
  name: string;
  customerId?: string;
  workflowId?: string;
  status?: string;
  summary?: string;
  avatar?: string;
  initials?: string;
  channel: ChannelType;
  channels?: string[];
  channelLabel: string;
  channelColor: string;
  phone?: string;
  email?: string;
  unread: number;
  timestamp: string;
  lastMessage: string;
  messages: Message[];
  createdAt?: string;
  updatedAt?: string;
}

export type ParticipantType = 'human' | 'agent' | 'customer';
export type BookingStatus = 'Confirmed' | 'Pending' | 'Cancelled' | 'Completed';

export interface ScheduleEvent {
  id: string;
  title: string;
  time: string;
  startTime: string;
  endTime: string;
  dateKey: string; // YYYY-MM-DD
  dayIndex: number;
  dateNum: number;
  topOffset?: number;
  height?: number;
  client: string;
  email: string;
  phone?: string;
  attendee: string;
  participantType: ParticipantType;
  type: string;
  location: string;
  status: BookingStatus;
  statusColor?: string;
  notes?: string;
}



/* Perfox's status vocabulary. Left as a string union of what it sends. */
export type AgentStatus = 'published' | 'paused' | 'draft' | string;

/**
 * An agent, cached from the connected Perfox workspace.
 *
 * Every field mirrors something Perfox reports. This platform adds no
 * configuration of its own — the row is a cache, so anything it cannot source
 * from Perfox has no business being here.
 */
export interface AIAgent {
  /** The Perfox agent id. One identity — no local id shadowing a remote one. */
  id: string;
  name: string;
  description: string;
  /** Perfox's own vocabulary: published | paused | draft. Stored verbatim. */
  status: AgentStatus;
  /** How conversations START — the agent's trigger channels. */
  channels: string[];
  /**
   * How the agent can REACH OUT — derived from the sender nodes wired on its
   * canvas (`whatsapp_sender`, `email_sender`, `sms_sender`, `phone_caller`).
   *
   * Kept separate from `channels` because they answer different questions: an
   * agent triggered by web chat can still hold a WhatsApp sender, and gating
   * outbound on `channels` wrongly hid it.
   */
  senderChannels: string[];
  /**
   * Channels the agent is TRIGGERED on, from the trigger nodes on its graph.
   *
   * Not the same as `senderChannels`, and not the same as Perfox's `channels`
   * field, which does not report every trigger. This is what decides whether an
   * agent can start a conversation on a channel.
   */
  triggerChannels: string[];
  activeVersion: number;
  nodeCount: number;
  /** Timestamps as Perfox reports them. */
  perfoxCreatedAt: string;
  perfoxUpdatedAt: string;
  /** When this row was last refreshed from Perfox. */
  syncedAt: string;
}

export type TransportType = 'HTTP' | 'SSE' | 'WebSocket';
export type EndpointAuthType = 'none' | 'bearer' | 'apiKey' | 'basic';

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  transport: TransportType;
  authType: EndpointAuthType;
  authConfig: {
    bearerToken?: string;
    headerName?: string;
    apiKeyValue?: string;
    basicAuth?: string;
  };
  headers?: { id: number; key: string; value: string }[];
  queryParams?: { id: number; key: string; value: string }[];
  bodyFormat?: string;
  bodyContent?: string;
  status: 'Healthy' | 'Degraded' | 'Offline';
  statusColor?: string;
  latency: string;
  connectedAgentsCount: number;
  lastPingStatus: string;
  lastPingTime: string;
}

export interface DashboardMetrics {
  totalCategories?: number;
  totalTeamMembers?: number;
  activeTeamMembers?: number;
  confirmedAppointments?: number;
  serverDate?: string;
  totalProducts: number;
  productsInStock: number;
  productsLowStock: number;
  totalConversations: number;
  unreadConversations: number;
  totalAppointments: number;
  upcomingAppointments: number;
  activeAgents: number;
  totalApiCalls: string;
  systemHealth: string;
}

/**
 * The tenant's connection to the Perfox platform. A singleton — the Developer
 * Hub cannot expose agents or webhook endpoints until this is set and verified.
 */
export interface PlatformConnection {
  id: string;
  apiUrl: string;
  apiToken: string;
  workspace?: string;
  status: 'Connected' | 'Unverified' | 'Error';
  lastVerifiedAt?: string;
  lastError?: string;
  connectedBy?: string;
  updatedAt?: string;

}

/**
 * A file this service uploaded to a Perfox knowledge-base folder.
 *
 * Perfox offers no way to enumerate files, so these rows keep the freshly
 * uploaded ones visible until the folder manifest catches up. A pointer only —
 * every displayed attribute is read back from Perfox.
 */
export interface KbFileRef {
  /** Perfox's file id. */
  fileId: string;
  folderId: string;
  name: string;
  uploadedAt: string;
  /** Email of whoever uploaded it, when known. */
  uploadedBy: string;
}

/** The knowledge-base folder selected against a platform connection. */
export interface PlatformKbFolder {
  /** Perfox's folder id; empty string when no folder has been chosen. */
  id: string;
  name: string;
  path: string;
  /** ISO timestamp of when this folder was selected. */
  selectedAt: string;
}
