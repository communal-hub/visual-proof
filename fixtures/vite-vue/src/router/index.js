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
import Interact from '../pages/Interact.vue'
import InvoiceNew from '../pages/InvoiceNew.vue'
import ProjectList from '../pages/ProjectList.vue'
import ProjectDetail from '../pages/ProjectDetail.vue'
import ClubList from '../pages/ClubList.vue'
import TeamList from '../pages/TeamList.vue'
import TeamDetail from '../pages/TeamDetail.vue'

const routes = [
  { path: '/', component: Home },
  { path: '/reports', component: Reports },
  { path: '/manage/invoices', component: InvoiceList },
  { path: '/manage/invoices/:id', component: InvoiceDetail },
  // v0.8 link discovery: a static sibling of the param route, a click-only list, and a nested param route.
  { path: '/manage/invoices/new', component: InvoiceNew },
  { path: '/manage/projects', component: ProjectList },
  { path: '/manage/projects/:id', component: ProjectDetail },
  { path: '/manage/clubs', component: ClubList },
  { path: '/manage/clubs/:clubId/teams', component: TeamList },
  { path: '/manage/clubs/:clubId/teams/:teamId', component: TeamDetail },
  { path: '/login', component: Login },
  { path: '/long', component: Long },
  { path: '/flagged', component: Flagged },
  { path: '/manage/interact', component: Interact },
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
