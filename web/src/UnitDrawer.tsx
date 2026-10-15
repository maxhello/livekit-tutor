import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { UnitGuideBody } from './UnitGuide'
import { unitLabel, type GuideUnit } from './units'

/**
 * 单元抽屉:首页单元卡片点开,列表与详情合在一起。
 * 桌面:左列表 + 右详情,点哪个单元右边立刻显示它的重点句/语法点;
 * 手机:一屏一栏,打开先看详情,「全部单元」回列表,列表里点单元再进详情。
 * 详情底部「练这个单元」= 选中并关闭。
 */
export default function UnitDrawer({
  units,
  current,
  selected,
  ttsBase,
  practiced,
  onPick,
  onClose,
}: {
  units: GuideUnit[]
  current: number
  selected: number
  ttsBase: string
  /** 练过几次(未登录/没拉到时为 null) */
  practiced: Record<number, number> | null
  onPick: (unitIndex: number) => void
  onClose: () => void
}) {
  /** 正在看的单元(打开时 = 已选单元) */
  const [viewing, setViewing] = useState(selected)
  /** 手机上当前显示哪一栏 */
  const [pane, setPane] = useState<'list' | 'detail'>('detail')
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const detailRef = useRef<HTMLDivElement | null>(null)
  const unit = units.find((u) => u.unitIndex === viewing) ?? units[0]

  /** 按阶段分组,保持 units 的新→旧顺序 */
  const groups = useMemo(() => {
    const m = new Map<number, GuideUnit[]>()
    for (const u of units) {
      if (!m.has(u.section)) m.set(u.section, [])
      m.get(u.section)!.push(u)
    }
    return [...m.entries()]
  }, [units])

  // 打开时列表滚到已选单元
  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'center' })
  }, [])

  // 换了单元,详情回到顶部
  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 })
  }, [viewing])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const times = (idx: number) => practiced?.[idx] ?? 0

  return (
    <>
      <div className="fixed inset-0 z-10 bg-[#030712]/55" onClick={onClose} />
      <aside
        aria-label="多邻国单元"
        className="slide-in fixed inset-y-0 right-0 z-20 flex w-[880px] max-w-full flex-col border-l border-gray-800 bg-[#0b1220] shadow-[-24px_0_48px_rgba(0,0,0,.4)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-5 py-4">
          {pane === 'detail' ? (
            <button
              onClick={() => setPane('list')}
              className="flex min-h-10 items-center gap-1 rounded-xl px-2 text-sm text-slate-300 hover:bg-slate-800/60 lg:hidden"
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
              全部单元
            </button>
          ) : (
            <h2 className="text-lg font-semibold lg:hidden">选择单元</h2>
          )}
          <h2 className="hidden text-lg font-semibold lg:block">多邻国单元</h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="flex size-10 flex-none items-center justify-center rounded-xl border border-gray-800 text-slate-300 hover:bg-slate-800/60"
          >
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 列表 */}
          <nav
            aria-label="单元列表"
            className={`thin-scroll min-h-0 w-full flex-col gap-5 overflow-y-auto p-3.5 lg:flex lg:w-[340px] lg:flex-none lg:border-r lg:border-gray-800 ${
              pane === 'list' ? 'flex' : 'hidden'
            }`}
          >
            {groups.map(([section, list]) => (
              <section key={section} className="flex flex-col gap-1.5">
                <h3 className="px-1.5 text-xs font-semibold tracking-wider text-gray-400">
                  第 {section + 1} 阶段{list[0].cefr && ` · ${list[0].cefr}`}
                </h3>
                {list.map((u) => {
                  const isViewing = u.unitIndex === viewing
                  const isCurrent = u.unitIndex === current
                  return (
                    <button
                      key={u.unitIndex}
                      ref={u.unitIndex === selected ? selectedRef : undefined}
                      onClick={() => {
                        setViewing(u.unitIndex)
                        setPane('detail')
                      }}
                      aria-current={isViewing}
                      className={`flex items-center gap-3 rounded-2xl border px-3 py-2.5 text-left ${
                        isViewing
                          ? 'border-cyan-400/60 bg-cyan-400/10'
                          : 'border-transparent hover:bg-[#0f1a2e]'
                      }`}
                    >
                      <span
                        className={`flex size-8 flex-none items-center justify-center rounded-full text-[13px] font-semibold ${
                          isCurrent ? 'emma-avatar' : 'bg-slate-800 text-slate-300'
                        }`}
                      >
                        {u.unitInSection}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-gray-100">
                          {u.objective}
                        </span>
                        <span className="flex flex-wrap gap-x-2 text-xs text-gray-400">
                          {isCurrent && <span className="text-cyan-300">当前</span>}
                          {u.unitIndex === selected && !isCurrent && (
                            <span className="text-cyan-300">已选</span>
                          )}
                          {u.grammar.length > 0 && <span className="text-violet-300">语法</span>}
                          {times(u.unitIndex) > 0 && <span>练过 {times(u.unitIndex)} 次</span>}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </section>
            ))}
          </nav>

          {/* 详情 */}
          {unit && (
            <div
              className={`min-h-0 min-w-0 flex-1 flex-col lg:flex ${
                pane === 'detail' ? 'flex' : 'hidden'
              }`}
            >
              <div ref={detailRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto p-5">
                <div className="mb-5">
                  <div className="text-[13px] text-cyan-300">
                    {unit.unitIndex === current ? '当前单元' : '复习单元'} · {unitLabel(unit)}
                    {unit.cefr && ` · ${unit.cefr}`}
                  </div>
                  <h3 className="mt-1 text-xl font-semibold">{unit.objective}</h3>
                  {practiced && (
                    <div className="mt-1 text-[13px] text-gray-400">
                      {times(unit.unitIndex) > 0
                        ? `和 Emma 练过 ${times(unit.unitIndex)} 次`
                        : '还没和 Emma 练过'}
                    </div>
                  )}
                </div>
                <UnitGuideBody key={unit.unitIndex} unit={unit} ttsBase={ttsBase} />
              </div>
              <div className="border-t border-gray-800 p-4">
                {unit.unitIndex === selected ? (
                  <button
                    onClick={onClose}
                    className="min-h-12 w-full rounded-2xl border border-cyan-400/40 bg-cyan-400/10 text-[15px] text-cyan-200"
                  >
                    已选这个单元 · 返回
                  </button>
                ) : (
                  <button
                    onClick={() => onPick(unit.unitIndex)}
                    className="btn-primary min-h-12 w-full rounded-2xl text-[15px]"
                  >
                    练这个单元
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
