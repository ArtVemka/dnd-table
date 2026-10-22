plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val rendererSource = rootProject.projectDir.parentFile.resolve("renderer")
val generatedAssets = layout.buildDirectory.dir("generated/rendererAssets")

val copyRenderer by tasks.registering(Sync::class) {
    from(rendererSource)
    into(generatedAssets.map { it.dir("renderer") })
    doLast {
        val index = generatedAssets.get().dir("renderer/index.html").asFile
        val tag = "<script src=\"../android-bridge.js\"></script>"
        val html = index.readText(Charsets.UTF_8)
        if (!html.contains(tag)) {
            index.writeText(html.replace("</head>", "    $tag\n  </head>"), Charsets.UTF_8)
        }
    }
}

android {
    namespace = "ru.dndstol.player"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.dndstol.player"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.7.0"
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(generatedAssets)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs = freeCompilerArgs + listOf("-opt-in=kotlin.ExperimentalUnsignedTypes")
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    // iroh вызывает java.lang.ref.Cleaner через Class.forName, и lint принимает
    // это за вызов нового API. Ошибка lint не должна останавливать сборку.
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

tasks.named("preBuild").configure { dependsOn(copyRenderer) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // AAR-вариант iroh: libiroh_ffi.so под каждый ABI Android и IrohAndroid
    // для инициализации JNI. Обычный computer.iroh:iroh содержит только
    // нативные библиотеки десктопа.
    implementation("computer.iroh:iroh-android:1.2.0")
}
