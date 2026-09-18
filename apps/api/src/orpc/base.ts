import type { auth } from '@repo/auth'
import { ORPCError, os } from '@orpc/server'

/** Better Auth session as resolved by `auth.api.getSession`. */
export type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

/** Initial context supplied by the HTTP layer (apps/api/src/index.ts). */
export interface RpcContext {
  session: Session | null
}

/**
 * Base procedure builder shared by every router.
 *
 * 1. Authentication: every procedure requires a valid Better Auth session.
 *    The HTTP layer resolves the session cookie and passes it in as context;
 *    anything without one is rejected with UNAUTHORIZED before the handler
 *    runs. Handlers can read `context.session.user` for the caller.
 *
 * 2. Error shaping: oRPC masks plain `Error`s as a generic "Internal server
 *    error". This sample surfaces the error name and message instead (for
 *    example AWS SDK `ValidationException`s), because the wizard's quick-fix
 *    flow relies on them to tell the operator what to change. Only
 *    authenticated users get this far, but the messages can still include AWS
 *    resource identifiers; harden this (log server-side, return a generic
 *    message) before exposing the API to a wider audience.
 */
export const base = os
  .$context<RpcContext>()
  .use(async ({ context, next }) => {
    if (!context.session) {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Sign in to use this API.',
      })
    }
    return next({ context: { session: context.session } })
  })
  .use(async ({ next }) => {
    try {
      return await next()
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error
      }
      if (error instanceof Error) {
        const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: `${name}${error.message}`,
          cause: error,
        })
      }
      throw error
    }
  })
