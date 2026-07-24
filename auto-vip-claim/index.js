export function activate(ctx) {
  const getToday = () => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    } catch {
      return new Date(Date.now() + 480 * 60 * 1000).toISOString().slice(0, 10)
    }
  }

  const claim = async () => {
    const today = getToday()
    const rec = await ctx.kugou.user.getVipMonthRecord().catch(() => null)
    const list = rec?.data?.list ?? rec?.data ?? []
    if (Array.isArray(list) && list.some(r => r.day === today || r.receive_day === today)) return
    const res = await ctx.kugou.user.claimDayVip(today).catch(() => null)
    if (res?.status === 1) {
      ctx.toast.success('已领取今日畅听会员 🎉')
    }
    await ctx.kugou.user.upgradeDayVip().catch(() => {})
  }

  setTimeout(claim, 3000)
  ctx.events.onTrackChange(() => claim())
}
