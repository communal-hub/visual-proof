<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const teams = ref(null)
onMounted(async () => {
  teams.value = await (await fetch(`/api/clubs/${route.params.clubId}/teams`)).json()
})
</script>

<template>
  <main>
    <h1>Teams</h1>
    <div v-if="!teams" class="spinner">Loading...</div>
    <ul v-else data-test="team-list">
      <li v-for="team in teams" :key="team.id">
        <router-link :to="`/manage/clubs/${route.params.clubId}/teams/${team.id}`">{{ team.name }}</router-link>
      </li>
    </ul>
  </main>
</template>
