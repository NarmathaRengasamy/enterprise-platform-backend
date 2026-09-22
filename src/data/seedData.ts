import {
  Product,
  Category,
  Conversation,
  ScheduleEvent,
  AIAgent,
  WebhookEndpoint,
  User,
} from '../types/index.js';

export const INITIAL_USERS: User[] = [
  {
    id: "usr-001",
    name: "Sarah Jenkins",
    email: "sarah@omniflow.io",
    // default plaintext password is "password123", will be hashed or matched in auth
    password: "$2a$10$YourHashedPasswordPlaceholderOrPlainMatch",
    department: "Executive Management",
    role: "Admin",
    status: "Active",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuDvsA0SyRMgVDd_ZvHO7xR-KX4vzsILGoQaRYH6T8O-pXTAj5t3wZQkf118gAFZZb6mE-gjUpNVRrwMfS-jPwPcd4IY3rzmp-CXeamPaIne3oriZhmtXN4VYL1GAIVE7k2VUv0XzcTon3zDYJw-u1yPAquvFvNDSbFPBLJaWrSkHNFxn4vQD1-TyaTmWzOSsv4UzZ8_l3RhHXewijfj2KPpT9c1RoXV01NH3w2MLjL8vtyX3-at_Y9X0g",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "team-1",
    name: "John Doe",
    email: "john@example.com",
    department: "Product Engineering",
    role: "Admin",
    status: "Active",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuAFkOnv9voeucwRjCIiqMFnK-BeVUegzjitgpks0FHkHwRY_3lJXew0ypnFSM1YBIeJf01Wy1yrNjffNkVqGWyvGDiv0AQ1jgzXycZhKQ96CKAyGoCkSvE5NSXzpRxNapyzvxUWJEeTdq_KRl8xOKw4PcpoMe75QSPqb8b-ypbZS2ECAhFH9r1-_1wE3aDo-W0WRyRIOjJTUHGHcUw-ZVAmWRtkr9epjcaXOMZCMEpoTOIi4q-Ge_aJ",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "team-2",
    name: "Jane Smith",
    email: "jane@example.com",
    department: "Content Operations",
    role: "Editor",
    status: "Active",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuDfZHBmhV-j_SZWz9PPhHwAW5ab127aYuTNkXyZVLWClJWTDEbfpAPM1U4tzM1nGEtHq3tXPdEJDWnr7dpJvA8LZdIuo1KbvMnwA0LjYFzoHWd3KiareYYwmHrBD0tHeD0CcMJiy9YJhNyGX7t5l-jhJ_Zj4HuLju0V7SGRcHSIq_hBwJngieafSW0JIK6iqxTIgHp3Gp9tETNIFONKKJcqQGuCQ6MxLB70m7AKbv-dv0AoU-9VIVi7",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "team-3",
    name: "Bob Wilson",
    email: "bob@example.com",
    department: "Customer Success",
    role: "Viewer",
    status: "Pending",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCHrG0_3RkE1GZJjL4vS1K48_lM1P0kZ2h5M0u8_h3qJ2w7m1a9fL2r5vP3oQ4_xG4eD9m4y8K3m7d0-oP1qK4o2w3x8y7a-mN6z0e",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
];

export const INITIAL_PRODUCTS: Product[] = [
  {
    id: "PRD001",
    name: "Urban Tech Minimalist Backpack",
    shortName: "Product 1",
    sku: "PRD001",
    categoryId: "CAT-001",
    category: "Electronics",
    categoryCode: "electronics",
    price: 1299,
    originalPrice: 1899,
    stock: 142,
    stockStatus: "In Stock",
    committed: 18,
    reorderPoint: 25,
    margin: "54.2%",
    discount: "31% OFF",
    image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80",
    gallery: [
      { id: 0, label: "Front", src: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80" },
      { id: 1, label: "Side", src: "https://images.unsplash.com/photo-1622560480605-d83c853bc5c3?auto=format&fit=crop&w=800&q=80" },
      { id: 2, label: "Angled", src: "https://images.unsplash.com/photo-1546938576-6e6a64f317cc?auto=format&fit=crop&w=800&q=80" },
      { id: 3, label: "Detail", src: "https://images.unsplash.com/photo-1581605405669-fcdf81165afa?auto=format&fit=crop&w=800&q=80" },
    ],
    description: "Engineered with waterproof ballistic nylon and ergonomic memory-foam shoulder straps. Features an internal padded 16-inch laptop compartment, hidden passport pocket, and quick-access magnetic modular pockets for effortless daily transit and travel.",
    variants: [
      { option: "Size", value: "M (Medium 20L)", price: 1299, stock: "18 units", status: "In Stock" },
      { option: "Size", value: "L (Large 28L)", price: 1599, stock: "12 units", status: "In Stock" },
      { option: "Colorway", value: "Stealth Slate", price: 1399, stock: "4 units (Low)", status: "Low Stock" },
    ],
    videos: [
      { id: 0, duration: "0:45", title: "Product Showcase", thumbnail: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=400&q=80" },
      { id: 1, duration: "1:20", title: "Durability & Transit Review", thumbnail: "https://images.unsplash.com/photo-1546938576-6e6a64f317cc?auto=format&fit=crop&w=400&q=80" }
    ]
  },
  {
    id: "PRD002",
    name: "Classic Chrono Sport Watch",
    shortName: "Product 2",
    sku: "PRD002",
    categoryId: "CAT-002",
    category: "Accessories",
    categoryCode: "accessories",
    price: 4499,
    originalPrice: 6999,
    stock: 85,
    stockStatus: "In Stock",
    committed: 5,
    reorderPoint: 15,
    margin: "48.0%",
    discount: "35% OFF",
    image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80",
    gallery: [
      { id: 0, label: "Front", src: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80" },
      { id: 1, label: "Side", src: "https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=800&q=80" },
      { id: 2, label: "Angled", src: "https://images.unsplash.com/photo-1533139502658-0198f920d8e8?auto=format&fit=crop&w=800&q=80" },
      { id: 3, label: "Detail", src: "https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?auto=format&fit=crop&w=800&q=80" },
    ],
    description: "Sleek water-resistant sports chronograph with sapphire crystal glass, precision Japanese quartz movement, and a premium brushed stainless steel case.",
    variants: [
      { option: "Color", value: "Midnight Black", price: 4499, stock: "40 units", status: "In Stock" },
      { option: "Color", value: "Ocean Blue", price: 4499, stock: "45 units", status: "In Stock" }
    ],
    videos: [
      { id: 0, duration: "0:50", title: "Timepiece Precision", thumbnail: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=400&q=80" },
      { id: 1, duration: "1:15", title: "Water Resistance Test", thumbnail: "https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=400&q=80" }
    ]
  },
  {
    id: "PRD003",
    name: "Nordic Minimalist Desk Lamp",
    shortName: "Product 3",
    sku: "PRD003",
    categoryId: "CAT-003",
    category: "Home",
    categoryCode: "lifestyle",
    price: 2899,
    originalPrice: 3999,
    stock: 3,
    stockStatus: "Low Stock",
    committed: 2,
    reorderPoint: 10,
    margin: "42.5%",
    discount: "28% OFF",
    image: "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=800&q=80",
    gallery: [
      { id: 0, label: "Front", src: "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=800&q=80" },
      { id: 1, label: "Side", src: "https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=800&q=80" },
      { id: 2, label: "Angled", src: "https://images.unsplash.com/photo-1534349762230-e0cadf78f5da?auto=format&fit=crop&w=800&q=80" },
      { id: 3, label: "Detail", src: "https://images.unsplash.com/photo-1540932239986-30128078f3c5?auto=format&fit=crop&w=800&q=80" },
    ],
    description: "Touch-activated dimmable LED desk lamp crafted with solid European beechwood, warm ambient color temperatures, and matte powder-coated steel hardware.",
    variants: [
      { option: "Finish", value: "Matte White", price: 2899, stock: "2 units", status: "Low Stock" },
      { option: "Finish", value: "Matte Charcoal", price: 2899, stock: "1 unit", status: "Low Stock" }
    ],
    videos: [
      { id: 0, duration: "0:40", title: "Lighting Moods & Dimming", thumbnail: "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=400&q=80" },
      { id: 1, duration: "1:05", title: "Assembly & Placement Guide", thumbnail: "https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=400&q=80" }
    ]
  },
  {
    id: "PRD004",
    name: "Apex Ergonomic Executive Chair",
    shortName: "Product 4",
    sku: "PRD004",
    categoryId: "CAT-003",
    category: "Home",
    categoryCode: "furniture",
    price: 14999,
    originalPrice: 21999,
    stock: 64,
    stockStatus: "In Stock",
    committed: 8,
    reorderPoint: 20,
    margin: "58.1%",
    discount: "32% OFF",
    image: "https://lh3.googleusercontent.com/aida-public/AB6AXuAy_f1NBsFJIrjXllqBAXCSkx8ErDxPXv9FJHKQKzVXxlAuE-M5nTgFOPSyTCYCxCAW6qf071JiTmBW6qR6DmBgtTdGR9arDmL8UFK680ZCJ2paI8q3OVKrelB2fMHha5ChqfqXfXBtLaA-KoXXoMn5vFitnHAmd-TbUmdcKoOejbsk3UejVjPcsSPiJKhjgNcn2rPWCWpcUVVbuzUi-000dW2UjIcpy6_GZ59mywZUdnL7iFPEdzC_Mw",
    gallery: [
      { id: 0, label: "Front", src: "https://lh3.googleusercontent.com/aida-public/AB6AXuAy_f1NBsFJIrjXllqBAXCSkx8ErDxPXv9FJHKQKzVXxlAuE-M5nTgFOPSyTCYCxCAW6qf071JiTmBW6qR6DmBgtTdGR9arDmL8UFK680ZCJ2paI8q3OVKrelB2fMHha5ChqfqXfXBtLaA-KoXXoMn5vFitnHAmd-TbUmdcKoOejbsk3UejVjPcsSPiJKhjgNcn2rPWCWpcUVVbuzUi-000dW2UjIcpy6_GZ59mywZUdnL7iFPEdzC_Mw" },
      { id: 1, label: "Side", src: "https://images.unsplash.com/photo-1505797149-43b0069ec26b?auto=format&fit=crop&w=800&q=80" },
      { id: 2, label: "Angled", src: "https://images.unsplash.com/photo-1592078615290-033ee584e267?auto=format&fit=crop&w=800&q=80" },
      { id: 3, label: "Detail", src: "https://images.unsplash.com/photo-1589384267710-7a170981ca78?auto=format&fit=crop&w=800&q=80" },
    ],
    description: "Engineered for 12+ hour postural support with adaptive lumbar alignment, breathable mesh backing, 4D adjustable armrests, and smooth synchronous tilt mechanism.",
    variants: [
      { option: "Colorway", value: "Slate Grey & Chrome", price: 14999, stock: "30 units", status: "In Stock" },
      { option: "Colorway", value: "Onyx Black & Matte Base", price: 15499, stock: "34 units", status: "In Stock" }
    ],
    videos: [
      { id: 0, duration: "1:10", title: "Ergonomic Posture Demo", thumbnail: "https://images.unsplash.com/photo-1580481077194-469a4733cf6a?auto=format&fit=crop&w=400&q=80" },
      { id: 1, duration: "1:45", title: "Lumbar & Tilt Adjustment", thumbnail: "https://images.unsplash.com/photo-1505797149-43b0069ec26b?auto=format&fit=crop&w=400&q=80" }
    ]
  },
  {
    id: "PRD005",
    name: "Solid Oak Motorized Standing Desk",
    shortName: "Product 5",
    sku: "PRD005",
    categoryId: "CAT-003",
    category: "Home",
    categoryCode: "furniture",
    price: 24999,
    originalPrice: 34999,
    stock: 22,
    stockStatus: "In Stock",
    committed: 4,
    reorderPoint: 8,
    margin: "51.5%",
    discount: "29% OFF",
    image: "https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?auto=format&fit=crop&w=800&q=80",
    gallery: [
      { id: 0, label: "Front", src: "https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?auto=format&fit=crop&w=800&q=80" },
      { id: 1, label: "Side", src: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?auto=format&fit=crop&w=800&q=80" },
      { id: 2, label: "Angled", src: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?auto=format&fit=crop&w=800&q=80" },
      { id: 3, label: "Detail", src: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=800&q=80" },
    ],
    description: "Handcrafted natural solid oak tabletop coupled with dual-motor whisper-quiet lift columns, anti-collision sensor, and 4 programmable memory presets.",
    variants: [
      { option: "Size", value: "140 x 70 cm", price: 24999, stock: "14 units", status: "In Stock" },
      { option: "Size", value: "160 x 80 cm", price: 28999, stock: "8 units", status: "In Stock" }
    ],
    videos: [
      { id: 0, duration: "0:55", title: "Dual-Motor Lift Action", thumbnail: "https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?auto=format&fit=crop&w=400&q=80" },
      { id: 1, duration: "1:30", title: "Cable Management Setup", thumbnail: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?auto=format&fit=crop&w=400&q=80" }
    ]
  },
  {
    id: "PRD006",
    name: "Studio Pro Wireless Headphones",
    shortName: "Product 6",
    sku: "PRD006",
    categoryId: "CAT-001",
    category: "Electronics",
    categoryCode: "electronics",
    price: 7999,
    originalPrice: 11999,
    stock: 58,
    stockStatus: "In Stock",
    committed: 7,
    reorderPoint: 12,
    margin: "62.0%",
    discount: "33% OFF",
    image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80",
    gallery: [
      { id: 0, label: "Front", src: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80" },
      { id: 1, label: "Side", src: "https://images.unsplash.com/photo-1484704849700-f032a568e944?auto=format&fit=crop&w=800&q=80" },
      { id: 2, label: "Angled", src: "https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=800&q=80" },
      { id: 3, label: "Detail", src: "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=800&q=80" },
    ],
    description: "Active noise-canceling circumaural studio headphones with custom 40mm beryllium drivers, 45-hour battery lifespan, and memory-foam leather ear cushions.",
    variants: [
      { option: "Color", value: "Matte Black", price: 7999, stock: "35 units", status: "In Stock" },
      { option: "Color", value: "Silver Aluminium", price: 7999, stock: "23 units", status: "In Stock" }
    ],
    videos: [
      { id: 0, duration: "1:00", title: "ANC Acoustic Test", thumbnail: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=400&q=80" },
      { id: 1, duration: "1:15", title: "Spatial Audio Review", thumbnail: "https://images.unsplash.com/photo-1484704849700-f032a568e944?auto=format&fit=crop&w=400&q=80" }
    ]
  },
  {
    id: "PRD007",
    name: "Italian Leather Bifold Wallet",
    shortName: "Product 7",
    sku: "PRD007",
    categoryId: "CAT-002",
    category: "Accessories",
    categoryCode: "accessories",
    price: 1499,
    originalPrice: 2299,
    stock: 110,
    stockStatus: "In Stock",
    committed: 12,
    reorderPoint: 20,
    margin: "45.0%",
    discount: "35% OFF",
    image: "https://images.unsplash.com/photo-1627123424574-724758594e93?auto=format&fit=crop&w=800&q=80",
    gallery: [
      { id: 0, label: "Front", src: "https://images.unsplash.com/photo-1627123424574-724758594e93?auto=format&fit=crop&w=800&q=80" },
      { id: 1, label: "Side", src: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&w=800&q=80" },
      { id: 2, label: "Angled", src: "https://images.unsplash.com/photo-1559563458-527698bf5295?auto=format&fit=crop&w=800&q=80" },
      { id: 3, label: "Detail", src: "https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=800&q=80" },
    ],
    description: "Vegetable-tanned full-grain Tuscan leather wallet with RFID blocking shielding, 8 card slots, and an ultra-slim pocket profile.",
    variants: [
      { option: "Leather", value: "Cognac Brown", price: 1499, stock: "60 units", status: "In Stock" },
      { option: "Leather", value: "Obsidian Black", price: 1499, stock: "50 units", status: "In Stock" }
    ],
    videos: [
      { id: 0, duration: "0:35", title: "Handcrafting & Stitching", thumbnail: "https://images.unsplash.com/photo-1627123424574-724758594e93?auto=format&fit=crop&w=400&q=80" },
      { id: 1, duration: "1:00", title: "RFID Protection Test", thumbnail: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&w=400&q=80" }
    ]
  },
  {
    id: "PRD008",
    name: "Tailored Linen Blend Overshirt",
    shortName: "Product 8",
    sku: "PRD008",
    categoryId: "CAT-004",
    category: "Fashion",
    categoryCode: "fashion",
    price: 3199,
    originalPrice: 4499,
    stock: 45,
    stockStatus: "In Stock",
    committed: 6,
    reorderPoint: 15,
    margin: "56.4%",
    discount: "29% OFF",
    image: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80",
    gallery: [
      { id: 0, label: "Front", src: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80" },
      { id: 1, label: "Side", src: "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=800&q=80" },
      { id: 2, label: "Angled", src: "https://images.unsplash.com/photo-1618354691373-d851c5c3a990?auto=format&fit=crop&w=800&q=80" },
      { id: 3, label: "Detail", src: "https://images.unsplash.com/photo-1598033129183-c4f50c736f10?auto=format&fit=crop&w=800&q=80" },
    ],
    description: "Breathable European flax blend overshirt designed with authentic horn buttons, relaxed modern cut, and reinforced double chest utility pockets.",
    variants: [
      { option: "Size", value: "M", price: 3199, stock: "20 units", status: "In Stock" },
      { option: "Size", value: "L", price: 3199, stock: "25 units", status: "In Stock" }
    ],
    videos: [
      { id: 0, duration: "0:45", title: "Fabric & Texture Closeup", thumbnail: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=400&q=80" },
      { id: 1, duration: "1:10", title: "Fit & Styling Guide", thumbnail: "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=400&q=80" }
    ]
  }
];

export const INITIAL_CATEGORIES: Category[] = [
  {
    id: "CAT-001",
    name: "Electronics",
    description: "Electronic devices and gadgets",
    productsCount: 25,
    updated: "2d ago",
    icon: "devices",
    color: "primary"
  },
  {
    id: "CAT-002",
    name: "Accessories",
    description: "Accessories for all products",
    productsCount: 18,
    updated: "5d ago",
    icon: "headphones",
    color: "secondary"
  },
  {
    id: "CAT-003",
    name: "Home",
    description: "Home decor, furniture, and kitchen items",
    productsCount: 18,
    updated: "1w ago",
    icon: "chair",
    color: "tertiary"
  },
  {
    id: "CAT-004",
    name: "Fashion",
    description: "Apparel, footwear, and style collections",
    productsCount: 14,
    updated: "3d ago",
    icon: "apparel",
    color: "primary"
  }
];

export const INITIAL_CONVERSATIONS: Conversation[] = [
  {
    id: "convo-1",
    name: "Aarav Sharma",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCKFmunIy3-evpPE9uq4tAsikVZJsjIcbM98yVf6taIVV9fcRZpyMsOOYSR7gE14Fp7dci_0tSkfSfGkOl0Xkqrjmfds4KYlrSwuEdDe7hZa2tFGG_-4MKDVRAX0I3Bf47WtMKJaqqxqomgMV2GrkYyQDMNfhXMa9RioY13aQXur0FNjyP9YsEKOd6JHfi4TZCXGlkhufXk1qR4BG4HsRoSgjvXQ17EKihEcy-rmpGhTZDWtJ1wqdsQMw",
    channel: "whatsapp",
    channelLabel: "WhatsApp",
    channelColor: "emerald",
    phone: "+91 98201 44521",
    email: "aarav@apexretail.in",
    unread: 2,
    timestamp: "10:42 AM",
    lastMessage: "Hi, could you send the quote for the Office Ergonomic...",
    messages: [
      {
        id: "m1",
        sender: "them",
        text: "Good morning Devon. We are finalizing our regional HQ refurbishment across Mumbai & Bengaluru. We need 48 ergonomic desk units.",
        time: "10:14 AM"
      },
      {
        id: "m2",
        sender: "me",
        text: "Hello Aarav! Outstanding news. We currently have standard commercial stock in Pune hub ready for 72-hour dispatch.",
        time: "10:18 AM"
      },
      {
        id: "m3",
        sender: "them",
        text: "Hi, could you send the quote for the Office Ergonomic Chairs (Large variant) and schedule a demo?",
        time: "10:39 AM",
        attachment: {
          title: "Apex Executive Chair",
          sku: "ERGO-X9-PRO",
          status: "In Stock",
          image: "https://lh3.googleusercontent.com/aida-public/AB6AXuAy_f1NBsFJIrjXllqBAXCSkx8ErDxPXv9FJHKQKzVXxlAuE-M5nTgFOPSyTCYCxCAW6qf071JiTmBW6qR6DmBgtTdGR9arDmL8UFK680ZCJ2paI8q3OVKrelB2fMHha5ChqfqXfXBtLaA-KoXXoMn5vFitnHAmd-TbUmdcKoOejbsk3UejVjPcsSPiJKhjgNcn2rPWCWpcUVVbuzUi-000dW2UjIcpy6_GZ59mywZUdnL7iFPEdzC_Mw"
        }
      }
    ]
  },
  {
    id: "convo-2",
    name: "Priya Patel",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuA4t8AMpjVV6rJhzRmA3T2nB4m-rGn3C7H7G26Xf_2CjaG0U65h7Md6ai-Kgu5sEsgTO5xURNEVx1CXBVkf7ygar8xdVkSX9yOm_BJfuIfYZPRfw0dDNIJKK05E_WrU0lpxuKhq4xhQncJcZbLYF8J4le-GuYz6WSgYUdReSOHc89PojuG7LlrG6Y7lEF_lfwsGKi5XS8E6YRi9KpAAVHQksTs73g5mMULlqr1fB4-7Bm7dZ-kjg_1gnA",
    channel: "sms",
    channelLabel: "SMS",
    channelColor: "amber",
    phone: "+91 94451 88321",
    email: "priya@urbanstudio.in",
    unread: 0,
    timestamp: "09:15 AM",
    lastMessage: "Thanks Devon! We received the updated invoice #4928.",
    messages: [
      {
        id: "m201",
        sender: "me",
        text: "Hi Priya, attached is the updated invoice #4928 for the fabric upholstery sample kit.",
        time: "09:10 AM"
      },
      {
        id: "m202",
        sender: "them",
        text: "Thanks Devon! We received the updated invoice #4928.",
        time: "09:15 AM"
      }
    ]
  },
  {
    id: "convo-3",
    name: "Vikram Malhotra",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuDd4XZ-EKcOX2A1jkkoBW_bASdMQY5NrAmSMEQ9-CLIsEy-aZPIFzDgVdq07JK_sbt96GeTTmggEDjg2Bh7EY0cM4__pL33z1AjbydHfJKo5911VCQOQEtallmcA-bImaEzgMN9c8IsoBON_PSyapQSnE-Vagp3cOnpYJe_DWNXy5LF9jlGktLRf4N6WspSdAgHM5iN7D7xG2YLxP70Lt29KB56Ky8a5ypBzpNkv1mOz_pmcI3QN_gU7g",
    channel: "email",
    channelLabel: "Email",
    channelColor: "sky",
    phone: "+91 98840 11920",
    email: "v.malhotra@zenithcorp.com",
    unread: 1,
    timestamp: "Yesterday",
    lastMessage: "Fwd: Security clearance checklist sandbox",
    messages: [
      {
        id: "m301",
        sender: "them",
        text: "Fwd: Security clearance checklist sandbox. Please review the OAuth2 scopes and SSO tokens before tomorrow's audit.",
        time: "Yesterday 4:30 PM"
      }
    ]
  },
  {
    id: "convo-4",
    name: "Sarah Jenkins",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuDvsA0SyRMgVDd_ZvHO7xR-KX4vzsILGoQaRYH6T8O-pXTAj5t3wZQkf118gAFZZb6mE-gjUpNVRrwMfS-jPwPcd4IY3rzmp-CXeamPaIne3oriZhmtXN4VYL1GAIVE7k2VUv0XzcTon3zDYJw-u1yPAquvFvNDSbFPBLJaWrSkHNFxn4vQD1-TyaTmWzOSsv4UzZ8_l3RhHXewijfj2KPpT9c1RoXV01NH3w2MLjL8vtyX3-at_Y9X0g",
    channel: "voice",
    channelLabel: "Phone",
    channelColor: "purple",
    phone: "+44 20 7946 0912",
    email: "sarah.j@omniflow.io",
    unread: 0,
    timestamp: "2d ago",
    lastMessage: "Call recording: Confirmed product specs",
    messages: [
      {
        id: "m401",
        sender: "them",
        text: "Call recording transcript: Confirmed 24 custom walnut executive desks for Phase 2 rollout.",
        time: "2d ago"
      }
    ]
  },
  {
    id: "convo-5",
    name: "David Miller",
    avatar: "",
    initials: "DM",
    channel: "whatsapp",
    channelLabel: "WhatsApp",
    channelColor: "emerald",
    phone: "+44 7700 900077",
    email: "david@logistics-uk.co",
    unread: 0,
    timestamp: "Oct 22",
    lastMessage: "Catalog dispatch arrived at Southampton hub.",
    messages: [
      {
        id: "m501",
        sender: "them",
        text: "Catalog dispatch arrived at Southampton hub. Clearance processed smoothly.",
        time: "Oct 22 11:15 AM"
      }
    ]
  }
];



export const INITIAL_SCHEDULE_EVENTS: ScheduleEvent[] = [
  {
    id: "ev-1",
    title: "Consultation with Apex Group",
    time: "09:00 AM - 10:00 AM",
    startTime: "09:00",
    endTime: "10:00",
    dateKey: "2026-09-17",
    dayIndex: 3,
    dateNum: 17,
    topOffset: 576,
    height: 64,
    client: "Apex Group",
    email: "contact@apexgroup.com",
    phone: "+91 98450 12345",
    attendee: "Aarav Sharma",
    participantType: "human",
    type: "Staff Consultation",
    location: "Teams Video Call",
    status: "Confirmed",
    statusColor: "emerald"
  },
  {
    id: "ev-2",
    title: "AI Voice Assistant Bot Demo",
    time: "10:30 AM - 11:30 AM",
    startTime: "10:30",
    endTime: "11:30",
    dateKey: "2026-09-15",
    dayIndex: 1,
    dateNum: 15,
    topOffset: 672,
    height: 64,
    client: "Siddharth Rao",
    email: "siddharth.rao@techcorp.io",
    phone: "+91 99880 54321",
    attendee: "OmniFlow AI Bot #02",
    participantType: "agent",
    type: "AI Autonomous Booking",
    location: "Automated Web Widget",
    status: "Confirmed",
    statusColor: "purple"
  },
  {
    id: "ev-3",
    title: "Site Measurement - Villa 402",
    time: "11:30 AM - 01:00 PM",
    startTime: "11:30",
    endTime: "13:00",
    dateKey: "2026-09-17",
    dayIndex: 3,
    dateNum: 17,
    topOffset: 736,
    height: 96,
    client: "Priya Patel",
    email: "priya.patel@homestayblr.in",
    phone: "+91 97411 88990",
    attendee: "Priya Patel (Client)",
    participantType: "customer",
    type: "Customer Self-Booked",
    location: "Koramangala 4th Block, BLR",
    status: "Confirmed",
    statusColor: "emerald"
  },
  {
    id: "ev-4",
    title: "Material Selection - Studio",
    time: "02:30 PM - 03:30 PM",
    startTime: "14:30",
    endTime: "15:30",
    dateKey: "2026-09-18",
    dayIndex: 4,
    dateNum: 18,
    topOffset: 928,
    height: 64,
    client: "Vikram Malhotra",
    email: "vikram.m@luxuryhomes.com",
    phone: "+91 91234 56780",
    attendee: "Vikram Malhotra (Client)",
    participantType: "customer",
    type: "Customer In-Studio Visit",
    location: "Design Studio Floor 2",
    status: "Pending",
    statusColor: "amber"
  },
  {
    id: "ev-5",
    title: "Automated Knowledge Sync Follow-up",
    time: "01:00 PM - 02:00 PM",
    startTime: "13:00",
    endTime: "14:00",
    dateKey: "2026-09-16",
    dayIndex: 2,
    dateNum: 16,
    topOffset: 832,
    height: 64,
    client: "Acme Logistics",
    email: "dispatch@acmelogistics.com",
    phone: "+91 94480 33221",
    attendee: "Perfox Dispatch Agent",
    participantType: "agent",
    type: "Agent Triggered",
    location: "API Webhook Runner",
    status: "Confirmed",
    statusColor: "purple"
  }
];

/* No seeded agents: the agent list is a cache of the connected Perfox
   workspace, so inventing rows here would put agents in the UI that exist
   nowhere. */
export const INITIAL_DEVELOPER_AGENTS: AIAgent[] = [];

export const INITIAL_DEVELOPER_ENDPOINTS: WebhookEndpoint[] = [
  {
    id: "ep-1",
    name: "Primary Event Webhook Gateway",
    url: "https://api.perfox.com/v1/omniflow-webhook",
    method: "POST",
    transport: "HTTP",
    authType: "bearer",
    authConfig: {
      bearerToken: "eyJhGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    },
    status: "Healthy",
    statusColor: "emerald",
    latency: "18 ms",
    connectedAgentsCount: 3,
    lastPingStatus: "200 OK",
    lastPingTime: "2 mins ago"
  },
  {
    id: "ep-2",
    name: "Schedule & Calendar Booking Sync",
    url: "https://api.perfox.com/v1/schedule-sync",
    method: "POST",
    transport: "HTTP",
    authType: "apiKey",
    authConfig: {
      headerName: "X-Perfox-API-Key",
      apiKeyValue: "pk_mock_8892019b38f8472910"
    },
    status: "Healthy",
    statusColor: "emerald",
    latency: "14 ms",
    connectedAgentsCount: 2,
    lastPingStatus: "200 OK",
    lastPingTime: "5 mins ago"
  },
  {
    id: "ep-3",
    name: "Realtime Chat SSE Event Stream",
    url: "https://api.perfox.com/v1/agent-sse-stream",
    method: "GET",
    transport: "SSE",
    authType: "none",
    authConfig: {},
    status: "Healthy",
    statusColor: "emerald",
    latency: "24 ms",
    connectedAgentsCount: 2,
    lastPingStatus: "200 OK",
    lastPingTime: "12 mins ago"
  },
  {
    id: "ep-4",
    name: "Enterprise CRM & Order Dispatch API",
    url: "https://crm.homestayblr.in/api/v2/contacts",
    method: "POST",
    transport: "HTTP",
    authType: "basic",
    authConfig: {
      basicAuth: "admin_integrations:SecretPass#2026"
    },
    status: "Healthy",
    statusColor: "emerald",
    latency: "32 ms",
    connectedAgentsCount: 1,
    lastPingStatus: "200 OK",
    lastPingTime: "18 mins ago"
  }
];
