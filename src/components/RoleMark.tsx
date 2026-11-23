import type { AgentRole } from '../../shared/agents'
import { avatarUrl } from '../../shared/avatar'
import { DoopMark } from './Logo'
import { cn } from '@/lib/utils'

/** A role's badge: either its uploaded avatar image or a filled circle in the
 *  role's crew colour with the white Doop mark inside. `size` is the circle's
 *  diameter; the mark takes about half of it. An unknown role gets a neutral
 *  ink circle so a stale card still reads. */
export function RoleMark({
  role,
  size = 14,
  className,
  style,
}: {
  role?: Pick<AgentRole, 'color'> & { avatar?: string | null }
  size?: number
  className?: string
  style?: React.CSSProperties
}) {
  const image = avatarUrl(role?.avatar)
  return (
    <span
      className={cn('inline-grid flex-none place-items-center overflow-hidden rounded-full align-middle', className)}
      style={{ width: size, height: size, background: role?.color ?? 'var(--ink-faint)', ...style }}
      aria-hidden
    >
      {image ? (
        <img src={image} alt="" className="size-full object-cover" />
      ) : (
        <DoopMark size={Math.round(size * 0.55)} color="#fff" className="block" />
      )}
    </span>
  )
}
