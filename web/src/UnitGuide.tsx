import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { ttsUrl, type GuideBlock, type GuideSentence, type GuideUnit } from './units'

/**
 * 单元指南正文(在单元抽屉 UnitDrawer.tsx 的详情栏里显示)。
 * 内容与交互对齐站点学习路径页的指南(src/components/UnitGuide.tsx):
 * 重点语句可听整句、点词看释义并读该词、英文下有中文;语法点讲解 + 例句 + 表格。
 */

/* ── 读音:同一时刻只放一段 ── */
let playing: HTMLAudioElement | null = null
function play(url: string) {
  if (!url) return
  playing?.pause()
  playing = new Audio(url)
  void playing.play().catch(() => {})
}

function SpeakerButton({ url, small = false }: { url: string; small?: boolean }) {
  if (!url) return null
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        play(url)
      }}
      aria-label="播放读音"
      className={`flex flex-none items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 active:scale-95 ${
        small ? 'size-8' : 'size-10'
      }`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className={small ? 'size-4' : 'size-5'} fill="none">
        <path
          d="M4 9.5v5a1 1 0 0 0 1 1h2.6l4.2 3.4a.8.8 0 0 0 1.3-.6V5.7a.8.8 0 0 0-1.3-.6L7.6 8.5H5a1 1 0 0 0-1 1Z"
          fill="currentColor"
        />
        <path d="M16 9a4.2 4.2 0 0 1 0 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M18.8 6.3a8 8 0 0 1 0 11.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </button>
  )
}

/** `**x**` → 加粗高亮(官方讲解里加粗的就是重点) */
function rich(s: string): ReactNode {
  return s.split(/\*\*(.+?)\*\*/g).map((p, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-cyan-200">
        {p}
      </strong>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  )
}

/** 可点词的句子:点词弹释义 + 读该词 */
function TappableSentence({
  s,
  ttsBase,
  id,
  open,
  setOpen,
}: {
  s: GuideSentence
  ttsBase: string
  id: string
  open: string | null
  setOpen: (k: string | null) => void
}) {
  const text = s.en.replace(/\*\*/g, '')
  const tokens = text.match(/[A-Za-z'’-]+|[^A-Za-z'’-]+/g) ?? [text]
  let wi = 0
  return (
    <span className="leading-loose">
      {tokens.map((tok, ti) => {
        const word = s.words[wi]
        if (word && tok === word.w) {
          wi += 1
          const key = `${id}-${ti}`
          const isOpen = open === key
          return (
            <span key={ti} className="relative inline-block" data-hint>
              <button
                type="button"
                onClick={() => {
                  setOpen(isOpen ? null : key)
                  if (!isOpen) play(ttsUrl(ttsBase, word.tts))
                }}
                className={`border-b-2 border-dotted ${
                  isOpen ? 'border-cyan-300 text-cyan-200' : 'border-gray-600 hover:border-cyan-400'
                }`}
              >
                {tok}
              </button>
              {isOpen && word.hints.length > 0 && (
                <span className="absolute left-1/2 top-full z-20 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-100 shadow-lg">
                  {word.hints.join(' / ')}
                </span>
              )}
            </span>
          )
        }
        return <Fragment key={ti}>{tok}</Fragment>
      })}
    </span>
  )
}

function GrammarBlock({ b, ttsBase }: { b: GuideBlock; ttsBase: string }) {
  if (b.type === 'text') return <p className="text-slate-300">{rich(b.text ?? '')}</p>
  if (b.type === 'example')
    return (
      <div className="flex items-start gap-2.5 border-l-2 border-cyan-500/40 pl-3">
        <SpeakerButton url={ttsUrl(ttsBase, b.tts)} small />
        <div>
          <div className="text-gray-100">{rich(b.en ?? '')}</div>
          {b.zh && <div className="text-xs text-gray-400">{b.zh}</div>}
        </div>
      </div>
    )
  if (b.type === 'table' && b.rows?.length)
    return (
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr>
              {b.rows[0].map((c, ci) => (
                <th key={ci} className="pb-1 pr-4 text-left font-medium text-cyan-200/80">
                  {rich(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.slice(1).map((r, ri) => (
              <tr key={ri} className="border-t border-gray-800">
                {r.map((c, ci) => (
                  <td key={ci} className="py-1 pr-4 align-top text-gray-200">
                    {rich(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  return null
}

/** 指南正文:重点语句 + 语法点(外层抽屉自己放标题) */
export function UnitGuideBody({ unit, ttsBase }: { unit: GuideUnit; ttsBase: string }) {
  /** 正在显示释义的词 */
  const [open, setOpen] = useState<string | null>(null)

  // 点空白处收起释义
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-hint]')) setOpen(null)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [open])

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wider text-gray-400">重点语句</h3>
        <p className="text-xs text-gray-500">点喇叭听整句，点单词看释义</p>
        <ul className="flex flex-col gap-2">
          {unit.keySentences.map((s, i) => (
            <li
              key={i}
              className="flex items-start gap-3 rounded-2xl border border-[#1a2436] bg-[#0f1a2e] p-3"
            >
              <SpeakerButton url={ttsUrl(ttsBase, s.tts)} />
              <div className="min-w-0">
                <div className="text-base text-gray-100">
                  <TappableSentence
                    s={s}
                    ttsBase={ttsBase}
                    id={`${unit.unitIndex}-${i}`}
                    open={open}
                    setOpen={setOpen}
                  />
                </div>
                {s.zh && <div className="mt-0.5 text-sm text-gray-400">{s.zh}</div>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {unit.grammar.map((g, gi) => (
        <section
          key={gi}
          className="flex flex-col gap-3 rounded-2xl border border-[#1a2436] bg-[#0f1a2e] p-4 text-sm"
        >
          <h3 className="text-xs font-semibold tracking-wider text-gray-400">语法点</h3>
          {g.title && <div className="text-base font-semibold text-gray-100">{g.title}</div>}
          {g.blocks.map((b, bi) => (
            <GrammarBlock key={bi} b={b} ttsBase={ttsBase} />
          ))}
        </section>
      ))}
    </div>
  )
}
