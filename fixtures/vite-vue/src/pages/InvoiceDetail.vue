<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import StatusBadge from '../components/StatusBadge.vue'

const route = useRoute()
const invoice = ref(null)
onMounted(async () => {
  invoice.value = await (await fetch(`/api/invoices/${route.params.id}`)).json()
})
</script>

<template>
  <main>
    <h1>Invoice</h1>
    <div v-if="!invoice" class="spinner">Loading...</div>
    <section v-else>
      <h2 data-test="invoice-number">{{ invoice.number }}</h2>
      <StatusBadge :status="invoice.status" />
      <p data-test="invoice-total">Total: {{ invoice.total }}</p>
    </section>
  </main>
</template>
