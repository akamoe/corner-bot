import { getStaffRole } from './auth.js'

// Middleware to restrict access to Admins only
export const requireAdmin = async (ctx, next) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') {
    return ctx.reply('⛔ Unauthorized.')
  }
  ctx.state.role = role
  return next()
}

// Middleware to restrict access to any Staff member (Admin or Cashier)
export const requireStaff = async (ctx, next) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role || (role !== 'admin' && role !== 'cashier')) {
    return ctx.reply('⛔ Unauthorized.')
  }
  ctx.state.role = role
  return next()
}
