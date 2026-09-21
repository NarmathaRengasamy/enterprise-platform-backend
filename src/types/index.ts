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
  category: string;
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
  fileUrl?: string;
  fileName?: string;
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
  toolStatus?: string;
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

export interface Article {
  id: string;
  title: string;
  category: string;
  categoryColor?: string;
  readTime: string;
  visibility: 'Public article' | 'Pinned' | 'Internal & Public' | 'Internal only';
  updated: string;
  icon: string;
  iconBg?: string;
  catBg?: string;
  views: string | number;
  content: string;
}

export interface Collection {
  id: string;
  title: string;
  description: string;
  articleCount: number;
  icon: string;
  color: string;
}

export type AgentStatus = 'Active' | 'Standby' | 'Disabled';

export interface AIAgent {
  id: string;
  name: string;
  workflowId: string;
  channel: string;
  model: string;
  siteKey: string;
  secretKey: string;
  accentColor: string;
  position: 'bottom-right' | 'bottom-left' | 'embed-inline';
  status: AgentStatus;
  statusColor?: string;
  totalCalls: string | number;
  avgLatency: string;
  assignedEndpoints: string[];
  description: string;
  createdAt?: string;
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
