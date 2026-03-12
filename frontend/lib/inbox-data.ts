export type Channel = 'Airbnb' | 'Booking.com' | 'Direct'
export type BookingType = 'Booking' | 'Inquiry'
export type MessageSender = 'guest' | 'autopilot' | 'host' | 'private'
export type AiStatus = 'on' | 'intervention' | 'off'
export type ReservationStatus = 'confirmed' | 'hosting' | 'inquiry'
export type CheckInStatus = 'confirmed' | 'cancelled' | 'checked-in' | 'checking-in-today' | 'checked-out' | 'inquiry'

export interface Message {
  id: string
  sender: MessageSender
  text: string
  time: string
  channel?: Channel
  agentName?: string
  imageUrls?: string[]
}

export interface Conversation {
  id: string
  guestName: string
  unitName: string
  channel: Channel
  bookingType: BookingType
  lastMessage: string
  lastMessageSender: MessageSender | ''
  timestamp: string
  aiOn: boolean
  aiMode: string
  aiStatus: AiStatus
  unreadCount: number
  reservationStatus: ReservationStatus
  checkInStatus: CheckInStatus
  messages: Message[]
  guest: {
    name: string
    email: string
    phone: string
    nationality: string
    language: string
    totalStays: number
    profileUrl: string
  }
  booking: {
    property: string
    checkIn: string
    checkOut: string
    guests: number
    source: Channel
    hostawayUrl: string
  }
  property: {
    address: string
    floor: string
    doorCode: string
    wifiName: string
    wifiPassword: string
    checkInTime: string
    checkOutTime: string
    parkingInfo: string
    notes: string
    houseRules: string
    keyPickup: string
    specialInstruction: string
  }
  aiSummary: string
  aiSummaryShort: string
}

export const conversations: Conversation[] = [
  {
    id: '1',
    guestName: 'Sophie Marceau',
    unitName: 'Unit 101 — Nile View Suite',
    channel: 'Airbnb',
    bookingType: 'Booking',
    lastMessageSender: 'guest',
    lastMessage: 'Is early check-in possible? We arrive at 10am.',
    timestamp: '10:42 AM',
    aiOn: true,
    aiMode: 'autopilot',
    aiStatus: 'on',
    unreadCount: 0,
    reservationStatus: 'confirmed',
    checkInStatus: 'checking-in-today',
    guest: {
      name: 'Sophie Marceau',
      email: 'sophie.marceau@email.com',
      phone: '+33 6 12 34 56 78',
      nationality: 'French',
      language: 'French / English',
      totalStays: 3,
      profileUrl: '#',
    },
    booking: {
      property: 'Nile View Suite',
      checkIn: 'Mar 14, 2026',
      checkOut: 'Mar 19, 2026',
      guests: 2,
      source: 'Airbnb',
      hostawayUrl: '#',
    },
    property: {
      address: '12 Corniche El Nil, Cairo, Egypt',
      floor: '4th Floor',
      doorCode: '4829#',
      wifiName: 'NileViewGuest',
      wifiPassword: 'Nile2026!',
      checkInTime: '3:00 PM',
      checkOutTime: '11:00 AM',
      parkingInfo: 'Street parking on Corniche El Nil, free after 8pm.',
      notes: 'Please leave the key in the lockbox upon checkout.',
      houseRules: '',
      keyPickup: '',
      specialInstruction: '',
    },
    aiSummary:
      'Sophie is inquiring about early check-in for her 5-night stay. She arrives at 10am and would like access before the standard 3pm check-in. Autopilot has already offered a tentative early check-in pending same-day availability.',
    aiSummaryShort: 'Early check-in request pending',
    messages: [
      {
        id: 'm1',
        sender: 'guest',
        text: 'Hi! So excited for our stay. Quick question — is early check-in at 10am possible? We have a flight landing at 8am.',
        time: '9:15 AM',
        channel: 'Airbnb',
      },
      {
        id: 'm2',
        sender: 'autopilot',
        text: "Hello Sophie! Thanks for reaching out. We'd love to accommodate you. Early check-in depends on same-day availability — we'll confirm by 8am on the day of your arrival. Fingers crossed!",
        time: '9:16 AM',
      },
      {
        id: 'm3',
        sender: 'guest',
        text: "That's great, thank you! Is there a fee for early check-in?",
        time: '10:40 AM',
        channel: 'Airbnb',
      },
      {
        id: 'm4',
        sender: 'host',
        text: "Hi Sophie! No fee at all — if the suite is ready, you're welcome to check in at no extra cost. We'll message you the morning of.",
        time: '10:42 AM',
        agentName: 'Nadia K.',
      },
    ],
  },
  {
    id: '2',
    guestName: 'James Whitfield',
    unitName: 'Unit 204 — Desert Rose Loft',
    channel: 'Booking.com',
    bookingType: 'Booking',
    lastMessageSender: 'guest',
    lastMessage: "The wifi password doesn't seem to be working.",
    timestamp: 'Yesterday',
    aiOn: true,
    aiMode: 'autopilot',
    aiStatus: 'intervention',
    unreadCount: 0,
    reservationStatus: 'hosting',
    checkInStatus: 'checked-in',
    guest: {
      name: 'James Whitfield',
      email: 'james.whitfield@email.com',
      phone: '+44 7700 900123',
      nationality: 'British',
      language: 'English',
      totalStays: 1,
      profileUrl: '#',
    },
    booking: {
      property: 'Desert Rose Loft',
      checkIn: 'Mar 7, 2026',
      checkOut: 'Mar 10, 2026',
      guests: 3,
      source: 'Booking.com',
      hostawayUrl: '#',
    },
    property: {
      address: '7 El Gezira St, Zamalek, Cairo, Egypt',
      floor: '2nd Floor',
      doorCode: '7741#',
      wifiName: 'DesertRoseGuest',
      wifiPassword: 'DesertRose2026#',
      checkInTime: '2:00 PM',
      checkOutTime: '12:00 PM',
      parkingInfo: 'Underground parking available, ask host for access code.',
      notes: 'Router is located in the hallway cabinet. Restart if wifi issues arise.',
      houseRules: '',
      keyPickup: '',
      specialInstruction: '',
    },
    aiSummary:
      "James is currently checked in and reporting a wifi issue. Autopilot provided the correct password but the guest says it still isn't working. The issue may require a router restart — this has been escalated to the host.",
    aiSummaryShort: 'WiFi issue needs intervention',
    messages: [
      {
        id: 'm1',
        sender: 'guest',
        text: "Hello, we just arrived. The wifi password on the welcome card doesn't seem to work. It's GuestRose2024?",
        time: 'Yesterday 3:10 PM',
        channel: 'Booking.com',
      },
      {
        id: 'm2',
        sender: 'autopilot',
        text: 'Hi James! Apologies for the trouble. The current password is DesertRose2026#. Please try that and let us know if it connects!',
        time: 'Yesterday 3:11 PM',
      },
      {
        id: 'm3',
        sender: 'guest',
        text: 'Tried that, still not connecting unfortunately.',
        time: 'Yesterday 4:55 PM',
        channel: 'Booking.com',
      },
    ],
  },
  {
    id: '3',
    guestName: 'Amara Diallo',
    unitName: 'Unit 102 — Palms Studio',
    channel: 'Direct',
    bookingType: 'Inquiry',
    lastMessageSender: 'guest',
    lastMessage: 'Do you allow pets? We have a small dog.',
    timestamp: 'Yesterday',
    aiOn: false,
    aiMode: 'off',
    aiStatus: 'off',
    unreadCount: 0,
    reservationStatus: 'inquiry',
    checkInStatus: 'inquiry',
    guest: {
      name: 'Amara Diallo',
      email: 'amara.diallo@email.com',
      phone: '+221 77 000 0000',
      nationality: 'Senegalese',
      language: 'French',
      totalStays: 0,
      profileUrl: '#',
    },
    booking: {
      property: 'Palms Studio',
      checkIn: 'Mar 22, 2026',
      checkOut: 'Mar 25, 2026',
      guests: 2,
      source: 'Direct',
      hostawayUrl: '#',
    },
    property: {
      address: '45 Hassan Allam St, Maadi, Cairo, Egypt',
      floor: 'Ground Floor',
      doorCode: '3312#',
      wifiName: 'PalmsStudioWifi',
      wifiPassword: 'Palms@2026',
      checkInTime: '3:00 PM',
      checkOutTime: '11:00 AM',
      parkingInfo: 'Free off-street parking in front of building.',
      notes: 'Small pets allowed with prior approval. Pet fee applies.',
      houseRules: '',
      keyPickup: '',
      specialInstruction: '',
    },
    aiSummary:
      'Amara is inquiring about a 3-night stay for 2 guests. She wants to bring a small dog. AI is currently OFF for this conversation — a host agent needs to respond manually regarding the pet policy.',
    aiSummaryShort: 'Pet policy inquiry, needs reply',
    messages: [
      {
        id: 'm1',
        sender: 'guest',
        text: "Hi there! I'm interested in booking the Palms Studio for March 22-25. Do you allow pets? We have a small 5kg dog named Biscuit.",
        time: 'Yesterday 11:20 AM',
        channel: 'Direct',
      },
      {
        id: 'm2',
        sender: 'host',
        text: 'Hi Amara! Great to hear from you. Let me check with the property team on our pet policy and get back to you shortly.',
        time: 'Yesterday 11:45 AM',
        agentName: 'Marcus T.',
      },
    ],
  },
  {
    id: '4',
    guestName: 'Lena Hoffmann',
    unitName: 'Unit 304 — Riverside Penthouse',
    channel: 'Airbnb',
    bookingType: 'Booking',
    lastMessageSender: 'guest',
    lastMessage: 'Absolutely wonderful stay, 5 stars!',
    timestamp: 'Mar 5',
    aiOn: true,
    aiMode: 'autopilot',
    aiStatus: 'on',
    unreadCount: 0,
    reservationStatus: 'confirmed',
    checkInStatus: 'checked-out',
    guest: {
      name: 'Lena Hoffmann',
      email: 'lena.hoffmann@email.de',
      phone: '+49 151 23456789',
      nationality: 'German',
      language: 'German / English',
      totalStays: 7,
      profileUrl: '#',
    },
    booking: {
      property: 'Riverside Penthouse',
      checkIn: 'Mar 1, 2026',
      checkOut: 'Mar 5, 2026',
      guests: 4,
      source: 'Airbnb',
      hostawayUrl: '#',
    },
    property: {
      address: '3 Corniche El Maadi, Cairo, Egypt',
      floor: '10th Floor — Penthouse',
      doorCode: '9901#',
      wifiName: 'RiversidePHWifi',
      wifiPassword: 'River@Top2026',
      checkInTime: '3:00 PM',
      checkOutTime: '11:00 AM',
      parkingInfo: 'Dedicated parking spot B-12 in basement.',
      notes: 'Key card access required for rooftop terrace. Card is on the counter.',
      houseRules: '',
      keyPickup: '',
      specialInstruction: '',
    },
    aiSummary:
      'Lena and her group completed a 4-night stay at the Riverside Penthouse. The stay went smoothly with no issues. Lena left a very positive message upon checkout.',
    aiSummaryShort: 'Guest left 5-star feedback',
    messages: [
      {
        id: 'm1',
        sender: 'guest',
        text: 'Just checked out — absolutely wonderful stay. Everything was perfect. Will definitely be back. 5 stars!',
        time: 'Mar 5, 11:00 AM',
        channel: 'Airbnb',
      },
      {
        id: 'm2',
        sender: 'autopilot',
        text: "Thank you so much, Lena! It was a pleasure hosting you. We'd love to welcome you and your group back anytime. Safe travels!",
        time: 'Mar 5, 11:01 AM',
      },
    ],
  },
  {
    id: '5',
    guestName: 'Carlos Mendez',
    unitName: 'Unit 205 — Old Town Hideaway',
    channel: 'Booking.com',
    bookingType: 'Inquiry',
    lastMessageSender: 'guest',
    lastMessage: 'What time is checkout? Asking for a friend haha',
    timestamp: 'Mar 4',
    aiOn: false,
    aiMode: 'off',
    aiStatus: 'off',
    unreadCount: 0,
    reservationStatus: 'hosting',
    checkInStatus: 'confirmed',
    guest: {
      name: 'Carlos Mendez',
      email: 'carlos.mendez@email.mx',
      phone: '+52 55 1234 5678',
      nationality: 'Mexican',
      language: 'Spanish / English',
      totalStays: 2,
      profileUrl: '#',
    },
    booking: {
      property: 'Old Town Hideaway',
      checkIn: 'Mar 3, 2026',
      checkOut: 'Mar 6, 2026',
      guests: 1,
      source: 'Booking.com',
      hostawayUrl: '#',
    },
    property: {
      address: '18 Al Muizz St, Islamic Cairo, Egypt',
      floor: '1st Floor',
      doorCode: '5567#',
      wifiName: 'OldTownGuest',
      wifiPassword: 'OldTown@26',
      checkInTime: '2:00 PM',
      checkOutTime: '11:00 AM',
      parkingInfo: 'No on-site parking. Nearest lot is 5 min walk on Al Azhar St.',
      notes: 'Historic building — please handle the wooden shutters gently.',
      houseRules: '',
      keyPickup: '',
      specialInstruction: '',
    },
    aiSummary:
      'Carlos is currently staying and asked about checkout time. AI is OFF. No response has been sent yet — needs attention.',
    aiSummaryShort: 'Checkout time question unanswered',
    messages: [
      {
        id: 'm1',
        sender: 'guest',
        text: 'Hey, what time is checkout? Asking for a friend haha. But actually asking for myself.',
        time: 'Mar 4, 9:30 AM',
        channel: 'Booking.com',
      },
    ],
  },
]
