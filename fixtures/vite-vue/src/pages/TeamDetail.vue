<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const team = ref(null)
onMounted(async () => {
  team.value = await (await fetch(`/api/clubs/${route.params.clubId}/teams/${route.params.teamId}`)).json()
})
</script>

<template>
  <main>
    <h1>Team</h1>
    <div v-if="!team" class="spinner">Loading...</div>
    <section v-else>
      <h2 data-test="team-name">{{ team.name }}</h2>
      <p data-test="team-club">{{ team.club }}</p>
    </section>
  </main>
</template>
