// Simple in-memory state for admin multi-step flows
// WARNING: Since this is in-memory, it will be lost on Vercel cold starts.
export const adminFlowState = new Map()

// In-memory state for user ordering flow (customization + quantity)
// WARNING: Since this is in-memory, it will be lost on Vercel cold starts.
export const orderFlowState = new Map()
