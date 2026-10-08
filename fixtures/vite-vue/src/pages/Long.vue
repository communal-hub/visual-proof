<script setup>
import ScrollLayout from '../layouts/ScrollLayout.vue'

const rows = Array.from({ length: 60 }, (_, i) => i + 1)
</script>

<template>
  <ScrollLayout>
    <h1>Long page</h1>
    <ul class="rows">
      <li v-for="n in rows" :key="n" class="row">Row {{ n }}</li>
    </ul>
    <div class="bottom-marker" data-test="bottom-marker">The end</div>
  </ScrollLayout>
</template>

<style scoped>
.rows { list-style: none; margin: 0; padding: 0; }
.row { height: 40px; line-height: 40px; border-bottom: 1px solid #ddd; }
/* Solid green: the integration tests look for it in the last pixels of the still. */
.bottom-marker { height: 120px; background: rgb(0, 255, 0); color: #000; font-weight: bold; }
</style>
