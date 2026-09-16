const STORAGE_KEY = 'accounts'

const getToday = () => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  } catch {
    return new Date(Date.now() + 480 * 60 * 1000).toISOString().slice(0, 10)
  }
}

const isAuthExpired = (body) => {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body
  return (
    [body?.error_code, body?.err_code, body?.errcode, payload?.error_code, payload?.err_code, payload?.errcode].some(
      (code) => [20018, 51002].includes(Number(code)),
    ) ||
    [body?.msg, payload?.msg].some(
      (message) => typeof message === 'string' && message.includes('登录已过期'),
    )
  )
}

const hasClaimedToday = (rec) => {
  const today = getToday()
  const list = rec?.data?.list ?? rec?.data ?? []
  return Array.isArray(list) && list.some((r) => r.day === today || r.receive_day === today)
}

export function activate(ctx) {
  const { defineAsyncComponent, defineComponent, h, ref } = ctx.vue
  const Button = defineAsyncComponent(ctx.ui.components.Button)
  const Dialog = defineAsyncComponent(ctx.ui.components.Dialog)

  const getAccounts = async () => {
    const saved = await ctx.storage.get(STORAGE_KEY).catch(() => null)
    return Array.isArray(saved?.list) ? saved.list : []
  }

  const saveAccounts = (list) => ctx.storage.set(STORAGE_KEY, { list })

  const readCurrentAccount = async () => {
    const [user, device] = await Promise.all([
      ctx.electron.storage.getKv('pinia:user').catch(() => null),
      ctx.electron.storage.getKv('pinia:device').catch(() => null),
    ])
    const info = user?.info
    const userid = Number(info?.userid ?? info?.userId ?? 0)
    const token = String(info?.token ?? '')
    if (!userid || !token) return null
    return {
      userid,
      token,
      t1: String(info?.t1 ?? ''),
      nickname: String(info?.nickname ?? info?.userName ?? ''),
      mobile: String(info?.mobile ?? ''),
      dfid: String(device?.info?.dfid ?? ''),
    }
  }

  const addCurrentAccount = async () => {
    const account = await readCurrentAccount()
    if (!account) return null
    const list = await getAccounts()
    const index = list.findIndex((a) => Number(a.userid) === account.userid)
    if (index >= 0) list[index] = { ...list[index], ...account }
    else list.push(account)
    await saveAccounts(list)
    return account
  }

  const buildAuth = (account) => {
    const parts = [`token=${account.token}`, `userid=${account.userid}`]
    if (account.t1) parts.push(`t1=${account.t1}`)
    if (account.dfid) parts.push(`dfid=${account.dfid}`)
    return parts.join(';')
  }

  const requestAs = async (account, url, params) => {
    const res = await ctx.electron.api
      .request({ method: 'GET', url, params, headers: { Authorization: buildAuth(account) } })
      .catch((error) => error?.response?.body ?? error?.response?.data ?? error?.body ?? null)
    return res?.body ?? res
  }

  const claimDayVip = async (record, claim, upgrade) => {
    const today = getToday()
    const rec = await record().catch(() => null)
    if (isAuthExpired(rec)) return 'expired'
    if (hasClaimedToday(rec)) return 'already'
    const res = await claim().catch(() => null)
    if (isAuthExpired(res)) return 'expired'
    await upgrade().catch(() => { })
    return Number(res?.status) === 1 ? 'claimed' : 'failed'
  }

  const claimAccount = (account) =>
    claimDayVip(
      () => requestAs(account, '/youth/month/vip/record'),
      () => requestAs(account, '/youth/day/vip', { receive_day: getToday() }),
      () => requestAs(account, '/youth/day/vip/upgrade'),
    )

  const claimCurrent = () =>
    claimDayVip(
      () => ctx.kugou.user.getVipMonthRecord(),
      () => ctx.kugou.user.claimDayVip(getToday()),
      () => ctx.kugou.user.upgradeDayVip(),
    )

  const getClaimStatus = async (account) => {
    const rec = await requestAs(account, '/youth/month/vip/record')
    if (isAuthExpired(rec)) return 'expired'
    return hasClaimedToday(rec) ? 'claimed' : 'pending'
  }

  let doneToday = ''
  const warned = new Set()
  const claim = async ({ silent = false, force = false } = {}) => {
    const today = getToday()
    if (!force && doneToday === today) return
    const current = await readCurrentAccount()
    const accounts = await getAccounts()
    const seen = new Set()
    let claimedCount = 0
    const expired = []

    if (current) {
      const status = await claimCurrent()
      if (status === 'claimed') claimedCount++
      seen.add(current.userid)
    }

    for (const account of accounts) {
      const id = Number(account.userid)
      if (seen.has(id)) continue
      seen.add(id)
      const status = await claimAccount(account)
      if (status === 'claimed') claimedCount++
      else if (status === 'expired' && !warned.has(id)) {
        warned.add(id)
        expired.push(account.userid)
      }
    }

    expired.forEach((uid) => ctx.toast.warning(`账号 ${uid} 登录已过期，请在设置中更新`))
    if (!expired.length) doneToday = today
    if (!silent) {
      if (claimedCount) ctx.toast.success(`已领取 ${claimedCount} 个账号的今日畅听会员`)
      else if (!expired.length) ctx.toast.info('今日畅听会员均已领取')
    }
  }

  const SettingsPanel = defineComponent({
    setup() {
      const accounts = ref([])
      const current = ref(null)
      const statuses = ref({})
      const running = ref(false)
      const confirmState = ref(null)

      const isCurrent = (userid) => Number(userid) === Number(current.value?.userid)

      const pill = (text, color, bg) =>
        h(
          'span',
          {
            style: `font-size:11px;line-height:1.4;padding:3px 8px;border-radius:999px;background:${bg};color:${color};`,
          },
          text,
        )

      const statusBadge = (userid) => {
        const map = {
          claimed: { text: '已领取', color: '#4ade80', bg: 'rgba(74,222,128,.15)' },
          pending: { text: '未领取', color: '#facc15', bg: 'rgba(250,204,21,.15)' },
          expired: { text: '已过期', color: '#f87171', bg: 'rgba(248,113,113,.15)' },
        }
        const s = map[statuses.value[Number(userid)]] ?? {
          text: '未知',
          color: '#94a3b8',
          bg: 'rgba(148,163,184,.15)',
        }
        return pill(s.text, s.color, s.bg)
      }

      const refreshStatuses = () => {
        accounts.value.forEach((account) => {
          getClaimStatus(account).then((status) => {
            statuses.value[Number(account.userid)] = status
          })
        })
      }

      const load = async () => {
        current.value = await readCurrentAccount()
        accounts.value = await getAccounts()
        refreshStatuses()
      }

      const saveCurrent = async () => {
        const account = await addCurrentAccount()
        if (!account) {
          ctx.toast.warning('请先登录')
          return
        }
        await load()
        ctx.toast.success(`已保存账号 ${account.userid} 信息`)
      }

      const runClaim = async () => {
        if (running.value) return
        running.value = true
        try {
          await claim({ force: true })
        } finally {
          running.value = false
          await load()
        }
      }

      const confirm = (title, message, onConfirm) => {
        confirmState.value = { title, message, onConfirm }
      }

      const remove = (userid) => {
        confirm('删除账号信息', `确定删除账号 ${userid} 的信息吗？`, async () => {
          const list = (await getAccounts()).filter((a) => Number(a.userid) !== Number(userid))
          await saveAccounts(list)
          await load()
          ctx.toast.success('已删除账号信息')
        })
      }

      const clearAll = () => {
        confirm('删除全部账号', '确定删除全部已保存的账号信息吗？', async () => {
          await saveAccounts([])
          await load()
          ctx.toast.success('已删除全部账号信息')
        })
      }

      load()

      return () =>
        h('div', { style: 'display: grid; gap: 10px;' }, [
          h(
            'p',
            { style: 'font-size:12px;opacity:.55;margin:0;line-height:1.6;' },
            '登录其它账号后点击「保存当前账号信息」，再切回自己账号即可实现每日自动领取和代领 VIP。',
          ),
          h('div', { style: 'display:flex;gap:8px;' }, [
            h(Button, { size: 'xs', onClick: saveCurrent }, () => '保存当前账号信息'),
            h(Button, { size: 'xs', onClick: runClaim }, () => '立即领取'),
            h(Button, { size: 'xs', variant: 'danger', onClick: clearAll }, () => '全部删除'),
          ]),
          ...(accounts.value.length
            ? [
              h('div', { style: 'display:grid;gap:6px;' }, [
                ...accounts.value.map((account) =>
                  h(
                    'div',
                    {
                      style:
                        'display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid rgba(128,128,128,.15);',
                    },
                    [
                      h(
                        'span',
                        {
                          style:
                            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
                        },
                        `${account.nickname || account.userid} · ${account.userid}`,
                      ),
                      ...(isCurrent(account.userid)
                        ? [pill('当前登录', '#3b82f6', 'rgba(59,130,246,.15)')]
                        : []),
                      statusBadge(account.userid),
                      h(
                        Button,
                        {
                          size: 'xs',
                          variant: 'danger',
                          style: 'margin-left:auto;',
                          onClick: () => remove(account.userid),
                        },
                        () => '删除',
                      ),
                    ],
                  ),
                ),
              ]),
            ]
            : []),
          h(
            Dialog,
            {
              open: !!confirmState.value,
              title: confirmState.value?.title,
              modal: true,
              closeOnEscape: true,
              closeOnInteractOutside: true,
              'onUpdate:open': (open) => {
                if (!open) confirmState.value = null
              },
            },
            {
              default: () =>
                h(
                  'p',
                  { style: 'margin:0;font-size:13px;opacity:.8;' },
                  confirmState.value?.message ?? '',
                ),
              footer: () =>
                h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;' }, [
                  h(
                    Button,
                    {
                      size: 'xs',
                      variant: 'outline',
                      onClick: () => {
                        confirmState.value = null
                      },
                    },
                    () => '取消',
                  ),
                  h(
                    Button,
                    {
                      size: 'xs',
                      variant: 'danger',
                      onClick: async () => {
                        const onConfirm = confirmState.value?.onConfirm
                        confirmState.value = null
                        await onConfirm?.()
                      },
                    },
                    () => '删除',
                  ),
                ]),
            },
          ),
        ])
    },
  })

  ctx.ui.settings.define({
    title: '自动领取 VIP',
    component: SettingsPanel,
  })

  setTimeout(claim, 3000)
  ctx.events.onTrackChange(() => claim({ silent: true }))
}
