<script setup>
import { ref, onMounted } from 'vue'
import StatusBadge from '@/components/StatusBadge.vue'

const invoices = ref(null)
onMounted(async () => {
  invoices.value = await (await fetch('/api/invoices')).json()
})
</script>

<template>
  <main>
    <h1>Invoices</h1>
    <p>
      <a href="https://example.com/manage/invoices/99">Archive (other site)</a>
      <router-link to="/manage/invoices/new">New invoice</router-link>
    </p>
    <div v-if="!invoices" class="spinner">Loading...</div>
    <ul v-else data-test="invoice-list">
      <li v-for="invoice in invoices" :key="invoice.id">
        <router-link :to="`/manage/invoices/${invoice.id}`">{{ invoice.number }}</router-link>
        <StatusBadge :status="invoice.status" />
      </li>
    </ul>
  </main>
</template>
