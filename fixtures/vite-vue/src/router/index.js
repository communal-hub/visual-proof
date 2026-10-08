import { createRouter, createWebHistory } from 'vue-router'
import Home from '../pages/Home.vue'
import Reports from '../pages/Reports.vue'
import InvoiceList from '../pages/InvoiceList.vue'
import InvoiceDetail from '../pages/InvoiceDetail.vue'
import Login from '../pages/Login.vue'
import Settings from '../pages/Settings.vue'
import Profile from '../pages/Profile.vue'
import Long from '../pages/Long.vue'
import Flagged from '../pages/Flagged.vue'

const routes = [
  { path: '/', component: Home },
  { path: '/reports', component: Reports },
  { path: '/manage/invoices', component: InvoiceList },
  { path: '/manage/invoices/:id', component: InvoiceDetail },
  { path: '/login', component: Login },
  { path: '/long', component: Long },
  { path: '/flagged', component: Flagged },
  {
    path: '/settings',
    component: Settings,
    children: [{ path: 'profile', component: Profile }],
  },
  { path: '/about', component: () => import('../pages/About.vue') },
]

const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach(async (to) => {
  if (!to.path.startsWith('/manage/')) return true
  const res = await fetch('/api/me', { credentials: 'same-origin' })
  return res.status === 401 ? '/login' : true
})

export default router
