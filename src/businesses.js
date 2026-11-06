// Business configurations. Each business is a separate context: the shared specialist
// capabilities (intake, classifier, brief writer, reviewer) are the same code, parameterised
// only by the config of the business the run belongs to.
//
// Everything here is descriptive context written for this MVP. It contains NO property
// inventory, prices, availability or legal positions — the workflow must not invent them.

export const SHARED_CAPABILITIES = [
  { id: 'intake', label: 'Intake & validation' },
  { id: 'classifier', label: 'Request classifier' },
  { id: 'brief_writer', label: 'Client brief & response drafter' },
  { id: 'quality_reviewer', label: 'Quality reviewer' },
  { id: 'handoff_writer', label: 'Chief-of-Staff handoff writer' },
];

const f = (id, label, question) => ({ id, label, question });

export const BUSINESSES = [
  {
    id: 'natea',
    name: 'NATEA',
    order: 1,
    tagline: 'International property buyers and worker accommodation around Ferrol, plus automation services.',
    region: 'Ferrol and surrounding area (Galicia, Spain)',
    owner: 'Lea',
    chief_of_staff: 'Maya',
    signature: 'Lea\nNATEA',
    capabilities: SHARED_CAPABILITIES.map((c) => c.id),
    policies: [
      'Never state property availability, prices, rents or fees unless the client stated them.',
      'Never give legal, tax or immigration conclusions; offer to involve a qualified professional.',
      'Ask for missing information explicitly; do not assume it.',
      'Approval saves a draft for Maya; nothing is sent automatically.',
    ],
    categories: [
      {
        id: 'worker_accommodation',
        label: 'Worker accommodation',
        keywords: ['workers', 'employees', 'staff', 'crew', 'accommodation', 'housing for', 'lodging', 'team of', 'technicians', 'shipyard'],
        required: [
          f('headcount', 'Number of people', 'How many people need accommodation, and is that number fixed?'),
          f('duration', 'Length of stay', 'How long do you need the accommodation for?'),
          f('start_date', 'Start date', 'From what date do you need the accommodation?'),
          f('area', 'Preferred area / work site', 'Where is the work site, and how far from it can people stay?'),
          f('room_setup', 'Room setup', 'Do people need individual rooms, or is shared accommodation acceptable?'),
          f('budget', 'Budget range', 'Do you have a budget range per person or in total?'),
          f('contact_role', 'Decision maker', 'Who will approve the booking and handle invoicing on your side?'),
        ],
        next_actions: [
          'Confirm missing requirements with the client (questions in the draft).',
          'Lea/Maya check real accommodation options manually — no availability has been verified.',
          'Prepare a shortlist only from verified options once requirements are confirmed.',
        ],
      },
      {
        id: 'property_purchase',
        label: 'International property purchase',
        keywords: ['buy', 'buying', 'purchase', 'home', 'house', 'apartment', 'property', 'relocat', 'move to', 'moving to'],
        required: [
          f('buyer_origin', 'Buyer origin / language', 'Which country are you moving from, and which language do you prefer for our conversations?'),
          f('property_type', 'Property type', 'What type of property are you looking for (apartment, house, land)?'),
          f('bedrooms', 'Size / bedrooms', 'How many bedrooms or how much space do you need?'),
          f('area', 'Preferred area', 'Which areas around Ferrol interest you, or what matters most about the location?'),
          f('budget', 'Budget range', 'What budget range are you considering?'),
          f('timeline', 'Timeline', 'When would you ideally like to buy or move?'),
          f('financing', 'Financing', 'Will you finance the purchase with a mortgage, or buy without financing?'),
        ],
        next_actions: [
          'Confirm buying criteria with the client (questions in the draft).',
          'Schedule an intro call to understand priorities.',
          'Do not present listings until real, verified listings are sourced.',
          'Flag legal/tax questions for a qualified local professional.',
        ],
      },
      {
        id: 'automation_services',
        label: 'Automation services',
        keywords: ['automat', 'process', 'invoice', 'spreadsheet', 'manual', 'administrative', 'admin', 'workflow', 'software', 'paperwork'],
        required: [
          f('process', 'Process to automate', 'Which administrative process would you like to automate, step by step as it works today?'),
          f('volume', 'Volume / frequency', 'How often does this process run, and roughly how many items each time?'),
          f('tools', 'Current tools', 'Which tools or systems are used today (e.g. spreadsheets, email, accounting software)?'),
          f('people', 'People involved', 'How many people are involved, and who owns the process?'),
          f('goal', 'Desired outcome', 'What would a good result look like for you (time saved, fewer errors, faster reporting)?'),
          f('constraints', 'Constraints', 'Are there data-protection, approval or timing constraints we should know about?'),
        ],
        next_actions: [
          'Clarify the current process and volumes (questions in the draft).',
          'Offer a short discovery call to map the process.',
          'Do not quote prices or timelines until scope is understood.',
        ],
      },
    ],
  },
  {
    id: 'rewire',
    name: 'REWIRE',
    order: 2,
    tagline: 'Organizational diagnostics and AI-native work design.',
    region: 'Remote / international',
    owner: 'Lea',
    chief_of_staff: 'Maya',
    signature: 'Lea\nREWIRE',
    capabilities: SHARED_CAPABILITIES.map((c) => c.id),
    policies: [
      'Do not promise diagnostic outcomes or ROI figures.',
      'Do not quote prices before scope is agreed.',
      'Approval saves a draft for Maya; nothing is sent automatically.',
    ],
    categories: [
      {
        id: 'org_diagnostic',
        label: 'Organizational diagnostic',
        keywords: ['team', 'organization', 'organisation', 'diagnostic', 'culture', 'structure', 'roles', 'collaboration'],
        required: [
          f('org_size', 'Organization size', 'How large is the organization or team involved?'),
          f('problem', 'Presenting problem', 'What prompted you to look for a diagnostic now?'),
          f('sponsor', 'Sponsor', 'Who is sponsoring this work internally?'),
          f('timeline', 'Timeline', 'Is there a timeline or event driving this?'),
        ],
        next_actions: ['Clarify scope and sponsor.', 'Offer an exploratory conversation.'],
      },
      {
        id: 'ai_work_design',
        label: 'AI-native work design',
        keywords: ['ai', 'agents', 'automation', 'work design', 'redesign', 'llm'],
        required: [
          f('workflows', 'Workflows in scope', 'Which workflows or roles do you want to redesign?'),
          f('maturity', 'Current AI use', 'How is AI used in your organization today?'),
          f('sponsor', 'Sponsor', 'Who is sponsoring this work internally?'),
        ],
        next_actions: ['Map candidate workflows.', 'Offer an exploratory conversation.'],
      },
    ],
  },
  {
    id: 'polypreneur',
    name: 'Polypreneur',
    order: 3,
    tagline: 'Product experiments and content.',
    region: 'Online',
    owner: 'Lea',
    chief_of_staff: 'Maya',
    signature: 'Lea\nPolypreneur',
    capabilities: SHARED_CAPABILITIES.map((c) => c.id),
    policies: [
      'Do not commit to publishing dates or partnerships.',
      'Approval saves a draft for Maya; nothing is published or sent automatically.',
    ],
    categories: [
      {
        id: 'collaboration',
        label: 'Collaboration / content request',
        keywords: ['collaborat', 'podcast', 'interview', 'guest', 'content', 'newsletter', 'article', 'video'],
        required: [
          f('format', 'Format', 'What format do you have in mind?'),
          f('audience', 'Audience', 'Who is the audience?'),
          f('timing', 'Timing', 'What timing are you considering?'),
        ],
        next_actions: ['Check fit with current content plan.', 'Lea decides whether to engage.'],
      },
      {
        id: 'product_experiment',
        label: 'Product experiment feedback',
        keywords: ['product', 'experiment', 'beta', 'feedback', 'feature', 'tool'],
        required: [
          f('product', 'Product', 'Which product or experiment is this about?'),
          f('context', 'Context', 'How did you use it, and what happened?'),
        ],
        next_actions: ['Log feedback in the experiment notes.', 'Lea decides on follow-up.'],
      },
    ],
  },
];

// SAMPLE DATA — fictional clients and inquiries, clearly labelled. Any resemblance is accidental.
export const SAMPLE_INQUIRIES = {
  natea: [
    {
      key: 'natea-workers-8',
      title: 'Accommodation for 8 workers near Ferrol (3 months)',
      contact: { name: 'Jonas Albrecht (fictional)', company: 'Nordwerk Marine Services GmbH (fictional)', email: 'jonas.albrecht@example.invalid' },
      body: `Hello,

We are a marine engineering subcontractor and will send a team of 8 workers to a project at the shipyard in Ferrol. We need accommodation for about three months, starting early March. The team are technicians and would prefer to stay close to the work site.

Could you tell us what you can offer and how this works?

Best regards,
Jonas Albrecht
Project Coordinator`,
    },
    {
      key: 'natea-buyer-home',
      title: 'International buyer looking for a home near Ferrol',
      contact: { name: 'Sarah and Tom Whitfield (fictional)', email: 'whitfields@example.invalid' },
      body: `Hi,

My husband and I are from Ireland and are thinking about moving to Galicia next year. We would like to buy a house near the sea, ideally with 3 bedrooms and a small garden. We have visited Ferrol once and loved it.

Can you help us find a home and explain how buying works for foreigners?

Thanks,
Sarah Whitfield`,
    },
    {
      key: 'natea-automation-admin',
      title: 'Local company: automate an administrative process',
      contact: { name: 'Marta Castro (fictional)', company: 'Talleres Castro Ferrol S.L. (fictional)', email: 'marta@example.invalid' },
      body: `Buenos días,

I manage the office of a small workshop in Ferrol with 12 employees. Every month we spend two days copying supplier invoices from email into a spreadsheet and then into our accounting software. It is manual and we make mistakes.

Could you help us automate this administrative process?

Marta Castro
Office manager`,
    },
  ],
  rewire: [
    {
      key: 'rewire-diagnostic',
      title: 'Team collaboration diagnostic (sample)',
      contact: { name: 'Priya N. (fictional)', company: 'Example Logistics BV (fictional)', email: 'priya@example.invalid' },
      body: `Hi Lea, our operations organization of around 60 people has grown quickly and roles are unclear between teams. We would like a diagnostic of how collaboration actually works today. Is this something REWIRE does?`,
    },
  ],
  polypreneur: [
    {
      key: 'poly-podcast',
      title: 'Podcast guest invitation (sample)',
      contact: { name: 'Alex R. (fictional)', email: 'alex@example.invalid' },
      body: `Hey! I host a small podcast about solo founders running several businesses at once. Would you be up for a guest interview about your product experiments and content approach?`,
    },
  ],
};

export function seedBusinesses(store) {
  for (const b of BUSINESSES) store.upsertBusiness(b);
}
