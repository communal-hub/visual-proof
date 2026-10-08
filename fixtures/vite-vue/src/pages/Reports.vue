<script setup>
import { ref, onMounted } from 'vue'

const invoices = ref(null)
onMounted(async () => {
  invoices.value = await (await fetch('/api/invoices')).json()
})
</script>

<template>
  <main>
    <h1>Reports</h1>
    <div v-if="!invoices" class="spinner">Loading...</div>
    <p v-else data-test="report-total">
      Total billed: {{ invoices.reduce((sum, i) => sum + i.total, 0) }}
    </p>
  </main>
</template>
