<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 class="mb-3">{{$t("terminal")}} - {{ serviceName }} ({{ stackName }})</h1>

            <div class="mb-3">
                <button class="btn btn-normal me-2" @click="goBack">{{ $t("Back to Compose") }}</button>
                <router-link :to="toggleShell" class="btn btn-normal me-2">{{ shell === 'bash' ? $t("Switch to sh") : $t("Switch to bash") }}</router-link>
            </div>

            <Terminal class="terminal" :rows="20" mode="interactive" :name="terminalName" :stack-name="stackName" :service-name="serviceName" :shell="shell" :endpoint="endpoint"></Terminal>
        </div>
    </transition>
</template>

<script>
import { getContainerExecTerminalName } from "../../../common/util-common";

export default {
    components: {
    },
    data() {
        return {

        };
    },
    computed: {
        stackName() {
            return this.$route.params.stackName;
        },
        endpoint() {
            return this.$route.params.endpoint || "";
        },
        shell() {
            return this.$route.params.type;
        },
        serviceName() {
            return this.$route.params.serviceName;
        },
        terminalName() {
            return getContainerExecTerminalName(this.endpoint, this.stackName, this.serviceName, 0);
        },
        toggleShell() {
            let endpoint = this.$route.params.endpoint;
            const targetShell = this.shell === "bash" ? "sh" : "bash";

            let data = {
                name: "containerTerminal",
                params: {
                    stackName: this.stackName,
                    serviceName: this.serviceName,
                    type: targetShell,
                },
            };

            if (endpoint) {
                data.name = "containerTerminalEndpoint";
                data.params.endpoint = endpoint;
            }

            return data;
        },
    },
    mounted() {

    },
    methods: {
        goBack() {
            if (this.endpoint) {
                this.$router.push(`/compose/${this.stackName}/${this.endpoint}`);
            } else {
                this.$router.push(`/compose/${this.stackName}`);
            }
        }
    }
};
</script>

<style scoped lang="scss">
.terminal {
    height: 410px;
}
</style>
